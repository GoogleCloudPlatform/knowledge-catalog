import hashlib
import json
import logging
import os
import threading
from typing import Any

import pandas as pd
from google.adk.plugins.base_plugin import BasePlugin
from google.auth.transport.requests import AuthorizedSession
from google.cloud import bigquery, dataplex_v1

from metadata_propagation.dataplex_integration.glossary_management import (
    GlossaryClient,
)
from metadata_propagation.dataplex_integration.lineage_propagation import (
    LineageGraphTraverser,
)

from .context import (
    get_credentials,
    get_oauth_token,
    is_oauth_enabled,
    set_oauth_token,
)
from .doc_description_plugin import DocDescriptionPlugin
from .similarity_engine import SimilarityEngine

logger = logging.getLogger(__name__)


class GlossaryPlugin(BasePlugin):
    def __init__(
        self,
        project_id: str,
        location: str = "europe-west1",
        cache_dataset_id: str | None = None,
        cache_table_id: str | None = None,
    ):
        super().__init__(name="glossary_plugin")
        self.project_id = project_id
        self.location = location
        self.dataset_id = os.environ.get(
            "BIGQUERY_DATASET_ID", "retail_synthetic_data"
        )
        self.cache_dataset_id = cache_dataset_id or os.environ.get(
            "GLOSSARY_CACHE_DATASET_ID", self.dataset_id
        )
        self.cache_table_id = cache_table_id or os.environ.get(
            "GLOSSARY_CACHE_TABLE_ID", "glossary_embeddings_cache"
        )
        self._glossary_client = None
        self._similarity_engine = None
        self._bq_client = None
        self._catalog_client = None
        self._lineage_traverser = None
        self._link_check_cache = {}  # Cache for _check_link_exists: (dataset, table, col, term) -> bool
        self._lock = threading.Lock()

    def _get_bq_client(self):
        creds = get_credentials(self.project_id)
        return bigquery.Client(project=self.project_id, credentials=creds)

    def _ensure_initialized(self):
        creds = get_credentials(self.project_id)
        token = get_oauth_token()
        if not self._glossary_client:
            self._glossary_client = GlossaryClient(
                self.project_id, self.location, credentials=creds
            )
        if not self._similarity_engine:
            # Vertex AI models are best supported in us-central1 for now
            self._similarity_engine = SimilarityEngine(
                self.project_id, location="us-central1", credentials=creds
            )
        if not self._bq_client:
            self._bq_client = self._get_bq_client()
        if not self._catalog_client:
            try:
                self._catalog_client = dataplex_v1.CatalogServiceClient(
                    credentials=creds
                )
            except Exception as e:
                logger.warning(
                    f"Failed to initialize CatalogServiceClient (Dataplex Catalog): {e}"
                )
                self._catalog_client = None
        if not self._lineage_traverser:
            self._lineage_traverser = LineageGraphTraverser(
                self.project_id, self.location, token=token
            )

        # Spawn background cache warming thread at the very end when all clients are fully initialized
        if hasattr(self, "_similarity_engine") and self._similarity_engine:
            # Check if cache has not been warmed in this session yet
            if not hasattr(self, "_cache_warming_started"):
                self._cache_warming_started = True

                def warm_cache_thread():
                    set_oauth_token(token)
                    try:
                        terms = self._glossary_client.get_all_terms()
                        if terms:
                            self._cache_term_embeddings(terms)
                    except Exception as e:
                        logger.warning(
                            f"Background embedding cache warming failed: {e}"
                        )

                threading.Thread(target=warm_cache_thread, daemon=True).start()

    def _get_local_cache_path(self) -> str:
        # Make cache path portable by using a directory relative to the plugin file inside the workspace
        base_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../scratch")
        )
        os.makedirs(base_dir, exist_ok=True)
        return os.path.join(base_dir, "glossary_embeddings_cache.json")

    def _init_bq_cache_table_if_not_exists(self):
        """Creates the glossary_embeddings_cache table in BigQuery if missing."""
        client = self._bq_client
        table_ref = (
            f"{self.project_id}.{self.cache_dataset_id}.{self.cache_table_id}"
        )
        try:
            client.get_table(table_ref)
        except Exception:
            # Table doesn't exist, create it
            logger.info(
                f"Creating BigQuery glossary embeddings cache table: {table_ref}"
            )
            schema = [
                bigquery.SchemaField("term_id", "STRING", mode="REQUIRED"),
                bigquery.SchemaField("hash_val", "STRING", mode="REQUIRED"),
                bigquery.SchemaField(
                    "embedding_json", "STRING", mode="REQUIRED"
                ),
                bigquery.SchemaField(
                    "update_time",
                    "TIMESTAMP",
                    default_value="CURRENT_TIMESTAMP()",
                ),
            ]
            table = bigquery.Table(table_ref, schema=schema)
            client.create_table(table)

    def _load_hybrid_cache(self) -> dict[str, dict[str, Any]]:
        """Loads the glossary embeddings cache from local file or BigQuery fallback."""
        local_path = self._get_local_cache_path()

        # 1. Try local JSON cache
        if os.path.exists(local_path):
            try:
                with open(local_path) as f:
                    return json.load(f)
            except Exception as e:
                logger.warning(f"Failed to read local cache: {e}")

        # 2. Fallback to BigQuery cache
        logger.info(
            "Local cache missing or corrupt. Reading from BigQuery cache table..."
        )
        bq_cache = {}
        try:
            self._init_bq_cache_table_if_not_exists()
            table_ref = f"{self.project_id}.{self.cache_dataset_id}.{self.cache_table_id}"
            query = (
                f"SELECT term_id, hash_val, embedding_json FROM `{table_ref}`"
            )
            query_job = self._bq_client.query(query)
            for row in query_job.result():
                try:
                    emb = json.loads(row.embedding_json)
                    bq_cache[row.term_id] = {
                        "hash_val": row.hash_val,
                        "embedding": emb,
                    }
                except Exception:
                    pass

            # Save loaded BQ cache locally
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            with open(local_path, "w") as f:
                json.dump(bq_cache, f)

        except Exception as e:
            logger.warning(f"Failed to load cache from BigQuery: {e}")

        return bq_cache

    def _save_hybrid_cache(
        self,
        cache_data: dict[str, dict[str, Any]],
        new_entries: dict[str, dict[str, Any]],
    ):
        """Saves updated cache data back to both local JSON and BigQuery table."""
        local_path = self._get_local_cache_path()

        # 1. Save locally
        try:
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            with open(local_path, "w") as f:
                json.dump(cache_data, f)
        except Exception as e:
            logger.warning(f"Failed to write local cache: {e}")

        # 2. Save new entries to BigQuery
        if not new_entries:
            return

        try:
            self._init_bq_cache_table_if_not_exists()
            table_ref = f"{self.project_id}.{self.cache_dataset_id}.{self.cache_table_id}"

            # First, delete existing rows for the updated terms to avoid duplicates
            term_ids_str = ", ".join([f"'{tid}'" for tid in new_entries.keys()])
            delete_query = (
                f"DELETE FROM `{table_ref}` WHERE term_id IN ({term_ids_str})"
            )
            self._bq_client.query(delete_query).result()

            # Insert new rows
            rows_to_insert = []
            for term_id, data in new_entries.items():
                rows_to_insert.append(
                    {
                        "term_id": term_id,
                        "hash_val": data["hash_val"],
                        "embedding_json": json.dumps(data["embedding"]),
                    }
                )

            self._bq_client.insert_rows_json(table_ref, rows_to_insert)
            logger.info(
                f"Persisted {len(new_entries)} new glossary embeddings to BigQuery cache."
            )
        except Exception as e:
            logger.warning(f"Failed to persist cache to BigQuery: {e}")

    def _cache_term_embeddings(self, all_terms: list[dict[str, Any]]):
        """Pre-calculates and caches embeddings for all glossary terms using the Hybrid Cache Strategy."""
        if not self._similarity_engine.embedder:
            return

        # Load existing cache
        cache_data = self._load_hybrid_cache()

        texts_to_embed = []
        term_ids = []
        new_hashes = []

        # Map existing embeddings into similarity engine
        engine_embeddings = {}
        for term_id, data in cache_data.items():
            engine_embeddings[term_id] = data["embedding"]
        self._similarity_engine.set_term_embeddings(engine_embeddings)

        for term in all_terms:
            term_id = term["name"]
            text = f"{term['display_name']}: {term.get('description', '')}"
            curr_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

            # Check if we have a valid cached embedding with a matching hash
            cached_item = cache_data.get(term_id)
            if not cached_item or cached_item.get("hash_val") != curr_hash:
                texts_to_embed.append(text)
                term_ids.append(term_id)
                new_hashes.append(curr_hash)

        if texts_to_embed:
            logger.info(
                f"Generating embeddings for {len(texts_to_embed)} new/updated glossary terms..."
            )
            embs = self._similarity_engine.embedder.get_embeddings(
                texts_to_embed
            )

            new_entries = {}
            for i, term_id in enumerate(term_ids):
                new_item = {"hash_val": new_hashes[i], "embedding": embs[i]}
                cache_data[term_id] = new_item
                new_entries[term_id] = new_item
                # Also update similarity engine
                self._similarity_engine.term_embeddings[term_id] = embs[i]

            # Save updated cache
            self._save_hybrid_cache(cache_data, new_entries)

    def _resolve_project_number(self) -> str:
        """Dynamically resolves the numeric GCP project number using env variables, Resource Manager API, or compute metadata server."""
        # 1. Check environment variable first
        env_val = os.environ.get("GOOGLE_CLOUD_PROJECT_NUMBER")
        if env_val:
            return env_val

        # 2. Try to fetch via Cloud Resource Manager API using active credentials
        try:
            creds = get_credentials(self.project_id)
            authed_session = AuthorizedSession(creds)
            url = f"https://cloudresourcemanager.googleapis.com/v3/projects/{self.project_id}"
            response = authed_session.get(url)
            if response.status_code == 200:
                project_data = response.json()
                p_num = (
                    project_data.get("projectNumber")
                    or project_data.get("name", "").split("/")[-1]
                )
                if p_num and p_num.isdigit():
                    logger.info(
                        f"Successfully resolved project number dynamically: {p_num}"
                    )
                    return p_num
        except Exception as e:
            logger.debug(
                f"Could not dynamically resolve project number via Resource Manager API: {e}"
            )

        # 3. Try local Compute Metadata Server fallback (GCE/GKE/Cloud Run/Cloud Shell)
        try:
            import requests

            headers = {"Metadata-Flavor": "Google"}
            resp = requests.get(
                "http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id",
                headers=headers,
                timeout=1,
            )
            if resp.status_code == 200 and resp.text.strip().isdigit():
                p_num = resp.text.strip()
                logger.info(
                    f"Successfully resolved project number from GCE Metadata: {p_num}"
                )
                return p_num
        except Exception:
            pass

        # 4. Safe backward-compatible fallback
        return "1095607222622"

    def _populate_linked_term_cache(self, dataset_id: str, table_id: str):
        """Pre-populates the linked terms cache for all columns of a table using LookupEntryLinks (single API call, fully thread-safe)."""
        if not hasattr(self, "_linked_term_cache"):
            self._linked_term_cache = {}

        cache_table_key = (dataset_id, table_id)
        if not hasattr(self, "_populated_tables_cache"):
            self._populated_tables_cache = set()
        if not hasattr(self, "_populating_tables"):
            self._populating_tables = set()
        if not hasattr(self, "_cv"):
            self._cv = threading.Condition(self._lock)

        # 1. Thread-safe coordination to prevent concurrent populating of the same table
        with self._lock:
            while cache_table_key in self._populating_tables:
                logger.info(
                    f"Waiting for another thread to populate EntryLink cache for {table_id}..."
                )
                self._cv.wait()

            if cache_table_key in self._populated_tables_cache:
                return

            self._populating_tables.add(cache_table_key)

        self._ensure_initialized()
        client = self._catalog_client
        if not client:
            with self._lock:
                self._populating_tables.remove(cache_table_key)
                self._cv.notify_all()
            return

        # FQNs and project numbers
        project_number = self._resolve_project_number()

        # Candidate entries and location parents
        entry_ids = list(
            dict.fromkeys(
                [
                    self._get_entry_name(dataset_id, table_id),
                    self._get_entry_name(dataset_id, table_id).replace(
                        self.project_id, project_number
                    ),
                ]
            )
        )

        parent_locations = list(
            dict.fromkeys(
                [
                    f"projects/{self.project_id}/locations/{self.location}",
                    f"projects/{project_number}/locations/{self.location}",
                ]
            )
        )

        local_updates = {}
        for parent in parent_locations:
            for entry_name in entry_ids:
                try:
                    req = dataplex_v1.LookupEntryLinksRequest(
                        name=parent, entry=entry_name
                    )
                    logger.info(
                        f"Looking up EntryLinks for entry {entry_name} under parent {parent}..."
                    )
                    page_result = client.lookup_entry_links(request=req)
                    for link in page_result:
                        source_ref = next(
                            (
                                r
                                for r in link.entry_references
                                if r.type_
                                == dataplex_v1.EntryLink.EntryReference.Type.SOURCE
                            ),
                            None,
                        )
                        target_ref = next(
                            (
                                r
                                for r in link.entry_references
                                if r.type_
                                == dataplex_v1.EntryLink.EntryReference.Type.TARGET
                            ),
                            None,
                        )

                        if (
                            source_ref
                            and target_ref
                            and source_ref.path.startswith("Schema.")
                        ):
                            col_name = source_ref.path.split(".")[-1]
                            target_term_id = target_ref.name.split("/")[-1]

                            local_updates[(dataset_id, table_id, col_name)] = (
                                target_term_id
                            )
                            logger.info(
                                f"  [FOUND] Cached link for column {col_name} -> Term ID {target_term_id}"
                            )
                except Exception as ex:
                    logger.debug(
                        f"lookup_entry_links failed for parent={parent}, entry={entry_name}: {ex}"
                    )

        # 2. Thread-safe cache write and cleanup
        with self._lock:
            self._linked_term_cache.update(local_updates)
            self._populated_tables_cache.add(cache_table_key)
            if cache_table_key in self._populating_tables:
                self._populating_tables.remove(cache_table_key)
            self._cv.notify_all()

    def _get_linked_term(
        self, dataset_id: str, table_id: str, col_name: str
    ) -> str | None:
        """Fetches the linked glossary term ID for a column using LookupEntryLinks (cached, table-level lookup)."""
        cache_key = (dataset_id, table_id, col_name)
        if not hasattr(self, "_linked_term_cache"):
            self._linked_term_cache = {}

        # Populate cache for all columns of this table using lookup_entry_links
        self._populate_linked_term_cache(dataset_id, table_id)

        with self._lock:
            return self._linked_term_cache.get(cache_key)

    def _check_link_exists(
        self, dataset_id: str, table_id: str, col_name: str, term_id: str
    ) -> bool:
        """Checks if a specific term is already linked to a column using deterministic IDs."""
        linked_term_id = self._get_linked_term(dataset_id, table_id, col_name)
        if linked_term_id:
            source_term_id = term_id.rsplit("/", maxsplit=1)[-1]
            return linked_term_id == source_term_id
        return False

    def _is_column_linked(
        self, dataset_id: str, table_id: str, col_name: str
    ) -> bool:
        """Checks if a column has ANY glossary term linked to it using deterministic IDs."""
        return self._get_linked_term(dataset_id, table_id, col_name) is not None

    def recommend_terms_for_table(
        self,
        dataset_id: str,
        table_id: str,
        doc_path: list[str] | None = None,
        context_mode: str = "rag",
        datastore_id: str | None = None,
        min_confidence: float = 0.5,
    ) -> pd.DataFrame:
        """
        Fetches recommendations for all columns in a table using Vertex AI Embeddings and Documents.
        """
        self._ensure_initialized()

        table_ref = f"{self.project_id}.{dataset_id}.{table_id}"
        table = self._bq_client.get_table(table_ref)

        all_terms = self._glossary_client.get_all_terms()
        if not all_terms:
            logger.warning("No glossary terms found to recommend.")
            return pd.DataFrame()

        # Initialize DocDescriptionPlugin if documents are provided
        doc_plugin = None
        if doc_path:
            logger.info(
                f"Initializing DocDescriptionPlugin for Glossary in mode: {context_mode}"
            )
            doc_plugin = DocDescriptionPlugin(self.project_id, self.location)
            doc_plugin.load_document(
                doc_path, mode=context_mode, datastore_id=datastore_id
            )

        # 1. Warm up Term Cache
        self._cache_term_embeddings(all_terms)

        # 2. Batch Generate Column Embeddings
        col_metas = []
        col_texts = []
        for field in table.schema:
            meta = {
                "name": field.name,
                "description": field.description or "",
                "type": field.field_type,
            }
            col_metas.append(meta)
            # Use name and description for column semantic context
            col_texts.append(f"{field.name}: {field.description or ''}")

        col_embeddings = []
        if self._similarity_engine.embedder:
            logger.info(
                f"Generating batch embeddings for {len(col_texts)} columns in {table_id}..."
            )
            col_embeddings = self._similarity_engine.embedder.get_embeddings(
                col_texts, task_type="RETRIEVAL_QUERY"
            )

        # 3. Get Column Lineage (Upstream)

        # Get Column Lineage (Upstream - Multi-hop)
        # Entry name for lineage is the BigQuery FQN: bigquery:project.dataset.table
        lineage_fqn = f"bigquery:{self.project_id}.{dataset_id}.{table_id}"
        col_list = [f.name for f in table.schema]
        upstream_lineage = self._lineage_traverser.get_recursive_column_lineage(
            lineage_fqn, col_list
        )

        # Pre-embed column queries in batch for RAG mode to avoid N sequential size 1 embedding calls
        if doc_plugin and (doc_path or datastore_id):
            cols = [(f.name, f.field_type) for f in table.schema]
            doc_plugin.pre_embed_column_queries(table_id, cols)

        # 4. Get Recommendations (parallelized using ThreadPoolExecutor)
        recommendations = []
        from concurrent.futures import ThreadPoolExecutor

        oauth_active = is_oauth_enabled()
        main_token = get_oauth_token()

        def process_column(args):
            if oauth_active or main_token is not None:
                set_oauth_token(main_token)
            i, col_meta = args
            col_recs = []
            col_name = col_meta["name"]
            col_emb = col_embeddings[i] if i < len(col_embeddings) else None

            # A. Lineage-Based Recommendations (Multi-hop)
            lineage_hops = upstream_lineage.get(col_name, [])
            for hop in lineage_hops:
                try:
                    src_entity = hop[
                        "source_entity"
                    ]  # expected project.dataset.table
                    src_col = hop["source_column"]
                    hop_confidence = hop["confidence"]

                    # SEMANTIC GUARD: If this lineage link was penalized (e.g. Category vs Amount),
                    # we do NOT want to propagate glossary terms through it, though it stays
                    # for structural/description propagation.
                    if hop.get("semantic_penalty"):
                        continue

                    # Robust parsing of project.dataset.table
                    clean_entity = src_entity.replace("bigquery:", "")
                    parts = clean_entity.split(".")
                    if len(parts) >= 3:
                        src_dataset = parts[-2]
                        src_table = parts[-1]

                        # ENRICHMENT: Fetch upstream column description to improve semantic matching
                        try:
                            src_table_ref = (
                                f"{self.project_id}.{src_dataset}.{src_table}"
                            )
                            if not hasattr(self, "_table_cache"):
                                self._table_cache = {}
                            with self._lock:
                                cached_table = self._table_cache.get(
                                    src_table_ref
                                )

                            if not cached_table:
                                thread_client = self._get_bq_client()
                                cached_table = thread_client.get_table(
                                    src_table_ref
                                )
                                with self._lock:
                                    self._table_cache[src_table_ref] = (
                                        cached_table
                                    )

                            target_field = next(
                                (
                                    f
                                    for f in cached_table.schema
                                    if f.name == src_col
                                ),
                                None,
                            )
                            if target_field:
                                pass
                        except Exception:
                            pass

                        # HEURISTIC: Check if any of our known terms are linked upstream to this column via native EntryLinks
                        for term in all_terms:
                            term_id = term["name"]
                            found_link = self._check_link_exists(
                                src_dataset, src_table, src_col, term_id
                            )
                            if found_link:
                                # High confidence since we have a verified Dataplex Catalog association upstream
                                final_confidence = (
                                    1.0 if hop_confidence >= 0.85 else 0.7
                                )
                                col_recs.append(
                                    {
                                        "Column": col_name,
                                        "Suggested Term": term["display_name"],
                                        "Term Status": "✅ Existing in Glossary",
                                        "Source": "🔗 Dataplex Lineage",
                                        "Confidence": final_confidence,
                                        "Rationale": f"Propagated via Lineage from {src_entity} (Verified Dataplex Catalog Link)",
                                        "Term ID": term_id,
                                    }
                                )
                                break  # Found a term for this hop

                        if col_recs and col_recs[-1]["Column"] == col_name:
                            break  # Already found a term for this column at some hop
                except Exception as e:
                    logger.warning(
                        f"Failed to check upstream glossary links for {col_name} via {hop.get('source_entity')}: {e}"
                    )

            if col_recs and col_recs[-1]["Column"] == col_name:
                # Found a lineage-based recommendation for this column!
                # For demo clarity, we prioritize lineage and skip similarity-based suggestions for this column.
                return col_recs

            # B. Document Search
            if doc_plugin:
                allowed_terms = [t["display_name"] for t in all_terms]
                doc_rec = doc_plugin.recommend_glossary_terms_for_column(
                    table_id, col_name, col_meta["type"], allowed_terms
                )
                if doc_rec:
                    if context_mode == "datastore":
                        logger.info(
                            f"  [FOUND Datastore] Glossary recommendation found for '{col_name}'."
                        )
                    elif context_mode == "direct":
                        logger.info(
                            f"  [FOUND Direct] Glossary recommendation found for '{col_name}'."
                        )
                    else:
                        logger.info(
                            f"  [FOUND RAG] Glossary recommendation found for '{col_name}'."
                        )

                    raw_term = doc_rec["Proposed Term"]
                    clean_display = str(raw_term).strip().strip("'\"")
                    rationale = doc_rec["Rationale"]

                    # 1. Exact case-insensitive match against Dataplex terms
                    matched_term = next(
                        (
                            t
                            for t in all_terms
                            if t["display_name"].strip().lower()
                            == clean_display.lower()
                        ),
                        None,
                    )

                    # 2. Semantic/Lexical fallback match against Dataplex terms if document term wording differs
                    if not matched_term and all_terms:
                        sugs = self._similarity_engine.get_ranked_suggestions(
                            {"name": col_name, "description": clean_display},
                            all_terms,
                        )
                        if sugs and sugs[0]["confidence"] >= 0.45:
                            best_sug = sugs[0]
                            matched_term = {
                                "name": best_sug["term_name"],
                                "display_name": best_sug["display_name"],
                            }
                            rationale += f" (Mapped doc term '{clean_display}' -> '{best_sug['display_name']}')"

                    if matched_term:
                        term_display = matched_term["display_name"]
                        term_status = "✅ Existing in Glossary"
                        term_id = matched_term["name"]
                    else:
                        term_display = clean_display
                        term_status = "✨ New (Auto-Create)"
                        term_id = "(Auto-generated on Apply)"

                    col_recs.append(
                        {
                            "Column": col_name,
                            "Suggested Term": term_display,
                            "Term Status": term_status,
                            "Source": f"📄 Document ({context_mode.upper()})",
                            "Confidence": doc_rec["Confidence"],
                            "Rationale": rationale,
                            "Term ID": term_id,
                        }
                    )
                    # Prioritize Document hits over Similarity
                    return col_recs
                elif context_mode == "datastore":
                    logger.info(
                        f"  [NOT FOUND Datastore] No glossary recommendation found for '{col_name}' in Datastore."
                    )
                elif context_mode == "direct":
                    logger.info(
                        f"  [NOT FOUND Direct] No glossary recommendation found for '{col_name}' in document."
                    )
                else:
                    logger.info(
                        f"  [NOT FOUND RAG] No glossary recommendation found for '{col_name}' in document."
                    )

            # C. Similarity-Based Recommendations
            suggestions = self._similarity_engine.get_ranked_suggestions(
                col_meta, all_terms, col_embedding=col_emb
            )

            for sug in suggestions:
                term_id = sug["term_name"]

                # Targeted check for existing link
                if self._check_link_exists(
                    dataset_id, table_id, col_name, term_id
                ):
                    continue

                # Also check legacy check (description based)
                if f"Business Glossary: {sug['display_name']}" in col_meta.get(
                    "description", ""
                ):
                    continue

                col_recs.append(
                    {
                        "Column": col_name,
                        "Suggested Term": sug["display_name"],
                        "Term Status": "✅ Existing in Glossary",
                        "Source": "🧠 Semantic Match",
                        "Confidence": sug["confidence"],
                        "Rationale": sug.get("rationale")
                        or f"Lexical: {sug['signals']['lexical']}, Semantic: {sug['signals']['semantic']}",
                        "Term ID": term_id,
                    }
                )
            return col_recs

        with ThreadPoolExecutor(
            max_workers=min(len(col_metas), 10)
        ) as executor:
            results = list(executor.map(process_column, enumerate(col_metas)))

        for col_recs in results:
            recommendations.extend(col_recs)

        # Filter by confidence threshold
        filtered_recs = [
            r
            for r in recommendations
            if r.get("Confidence", 0.0) >= min_confidence
        ]

        logger.info(
            f"Generated {len(filtered_recs)} recommendations for {table_id} after filtering by confidence threshold >= {min_confidence}."
        )
        return pd.DataFrame(filtered_recs)

    def _get_entry_name(self, dataset_id: str, table_id: str):
        entry_id = f"bigquery.googleapis.com/projects/{self.project_id}/datasets/{dataset_id}/tables/{table_id}"
        # Harvested entries are in the @bigquery group at the same location as the BQ dataset
        return f"projects/{self.project_id}/locations/{self.location}/entryGroups/@bigquery/entries/{entry_id}"

    def _resolve_term_entry_name(self, term_resource_name: str) -> str | None:
        """Maps a Business Glossary term resource name to its Knowledge Catalog Entry name."""
        client = dataplex_v1.CatalogServiceClient(
            credentials=get_credentials(self.project_id)
        )

        # We try deterministic patterns FIRST as they are faster and don't rely on eventual consistency of Search
        # and avoid 501/404 errors in certain regions/environments.

        # Pattern 1: Direct Construction with Project ID
        # Format: projects/{id}/locations/{loc}/entryGroups/@dataplex/entries/{resource}
        group_prefix = f"projects/{self.project_id}/locations/{self.location}/entryGroups/@dataplex/entries"
        candidate_id = f"{group_prefix}/{term_resource_name}"
        try:
            client.get_entry(name=candidate_id)
            return candidate_id
        except Exception:
            pass

        # Pattern 2: Direct Construction with Project Number (Harvested format)
        project_number = self._resolve_project_number()
        term_res_num = term_resource_name.replace(
            self.project_id, project_number
        )
        candidate_num = f"{group_prefix}/{term_res_num}"
        try:
            client.get_entry(name=candidate_num)
            return candidate_num
        except Exception:
            pass

        # Pattern 3: Search fallback
        query = f'resource:"{term_resource_name}"'
        try:
            request = dataplex_v1.SearchEntriesRequest(query=query)
            results = client.search_entries(request=request)
            for res in results:
                if "glossaries" in res.entry_source.resource:
                    return res.entry_name
        except Exception as e:
            # Downgrade to debug/info if construction works anyway,
            # or if search is known to be flaky in this environment.
            logger.debug(
                f"Search fallback failed for glossary term resolution: {e}"
            )

        logger.error(
            f"Could not resolve glossary term to Catalog Entry: {term_resource_name}"
        )
        return None

    def _ensure_term_resource_name(
        self, term_id_or_display: str, column_name: str, term_display: str = ""
    ) -> tuple[str, bool, str]:
        """Ensures term_id_or_display is a valid Dataplex resource path, resolving or creating the term if needed.
        Returns (resource_name, was_auto_created, display_name).
        """
        import re

        if term_id_or_display and term_id_or_display.startswith("projects/"):
            return (
                term_id_or_display,
                False,
                term_display or term_id_or_display.split("/")[-1],
            )

        target_name = (
            term_display
            if (
                not term_id_or_display
                or term_id_or_display == "(Auto-generated on Apply)"
            )
            else term_id_or_display
        )
        clean_display = (
            re.sub(r"^(✨\s*\[NEW\]\s*|NEW_TERM:)", "", str(target_name))
            .strip()
            .strip("'\"")
        )
        all_terms = self._glossary_client.get_all_terms()

        # 1. Exact case-insensitive match
        for t in all_terms:
            if t["display_name"].strip().lower() == clean_display.lower():
                return t["name"], False, t["display_name"]

        # 2. Similarity fallback
        if all_terms and self._similarity_engine:
            sugs = self._similarity_engine.get_ranked_suggestions(
                {"name": column_name, "description": clean_display}, all_terms
            )
            if sugs and sugs[0]["confidence"] >= 0.45:
                return sugs[0]["term_name"], False, sugs[0]["display_name"]

        # 3. Auto-create missing term in the first available glossary
        glossaries = self._glossary_client.list_glossaries()
        if glossaries:
            glossary_name = glossaries[0]["name"]
            term_slug = (
                re.sub(r"[^a-z0-9-]", "-", clean_display.lower()).strip("-")[
                    :60
                ]
            )
            try:
                bg_client = dataplex_v1.BusinessGlossaryServiceClient(
                    credentials=get_credentials(self.project_id)
                )
                term = dataplex_v1.GlossaryTerm(
                    display_name=clean_display,
                    description=f"Auto-created glossary term for column {column_name}",
                    parent=glossary_name,
                )
                created = bg_client.create_glossary_term(
                    parent=glossary_name, term=term, term_id=term_slug
                )
                logger.info(
                    f"Auto-created missing Dataplex Glossary Term: {created.name}"
                )
                return created.name, True, clean_display
            except Exception as e:
                # If already exists, return the deterministic path
                candidate_path = f"{glossary_name}/terms/{term_slug}"
                logger.info(
                    f"Using glossary term path: {candidate_path} ({e})"
                )
                return candidate_path, False, clean_display

        return term_id_or_display, False, clean_display

    def apply_terms(
        self, dataset_id: str, table_id: str, updates: list[dict[str, str]]
    ) -> dict[str, Any]:
        """
        Applies glossary terms to columns using native Dataplex EntryLinks.
        updates: List of {'column': str, 'term_id': str, 'term_display': str}
        Returns dict with applied count and list of newly created terms.
        """
        self._ensure_initialized()
        client = dataplex_v1.CatalogServiceClient(
            credentials=get_credentials(self.project_id)
        )

        # 1. BigQuery update (Optional/Skipped as per previous preference)
        logger.info(
            f"Applying {len(updates)} glossary terms to {table_id} via native EntryLinks."
        )

        # EntryLinks for BigQuery entries MUST reside in the @bigquery EntryGroup
        parent_group = f"projects/{self.project_id}/locations/{self.location}/entryGroups/@bigquery"
        entry_name = self._get_entry_name(dataset_id, table_id)

        # Link Type for Glossary Definition
        link_type = (
            "projects/dataplex-types/locations/global/entryLinkTypes/definition"
        )

        created_terms = []
        applied_count = 0

        for up in updates:
            column = up["column"]
            raw_term_id = up["term_id"]
            term_display = up.get("term_display", "")
            term_resource_name, was_created, clean_name = (
                self._ensure_term_resource_name(
                    raw_term_id, column, term_display=term_display
                )
            )
            if was_created and clean_name not in created_terms:
                created_terms.append(clean_name)

            # Resolve to Catalog Entry Name
            term_entry_name = self._resolve_term_entry_name(term_resource_name)
            if not term_entry_name:
                logger.error(
                    f"Skipping {column}: Could not resolve glossary term to Catalog Entry ({term_resource_name})."
                )
                continue

            # Deterministic ID for idempotency: link_{table}_{column}
            # EntryLink IDs must be lowercase, alphanumeric/hyphens
            clean_column = column.replace("_", "-").lower()
            clean_table = table_id.replace("_", "-").lower()
            entry_link_id = f"link-{clean_table}-{clean_column}"

            try:
                # Create the EntryLink
                link = dataplex_v1.EntryLink()
                link.entry_link_type = link_type

                # Source: The Table Column
                source_ref = dataplex_v1.EntryLink.EntryReference()
                source_ref.name = entry_name
                source_ref.path = f"Schema.{column}"
                source_ref.type_ = (
                    dataplex_v1.EntryLink.EntryReference.Type.SOURCE
                )

                # Target: The Glossary Term
                target_ref = dataplex_v1.EntryLink.EntryReference()
                target_ref.name = term_entry_name
                target_ref.type_ = (
                    dataplex_v1.EntryLink.EntryReference.Type.TARGET
                )

                link.entry_references = [source_ref, target_ref]

                try:
                    # Create in @bigquery group
                    client.create_entry_link(
                        parent=parent_group,
                        entry_link_id=entry_link_id,
                        entry_link=link,
                    )
                    applied_count += 1
                    logger.info(
                        f"Created native link for {column} -> {up['term_display']} in @bigquery group"
                    )
                except Exception as e:
                    if "already exists" in str(e).lower():
                        applied_count += 1
                        logger.info(
                            f"Link for {column} already exists, skipping."
                        )
                    else:
                        raise e

            except Exception as e:
                logger.error(f"Failed to create EntryLink for {column}: {e}")
                # We continue with other updates even if one fails
                continue

        return {"applied_count": applied_count, "created_terms": created_terms}

    def scan_for_missing_glossary_terms(self, dataset_id: str) -> pd.DataFrame:
        """
        Scans all tables in a dataset for columns missing glossary terms using native EntryLinks (parallelized).
        """
        self._ensure_initialized()
        dataplex_v1.CatalogServiceClient(
            credentials=get_credentials(self.project_id)
        )

        dataset_ref = self._bq_client.dataset(dataset_id)
        tables = list(self._bq_client.list_tables(dataset_ref))

        gaps = []
        import threading
        from concurrent.futures import ThreadPoolExecutor

        lock = threading.Lock()

        main_token = get_oauth_token()

        def scan_table(table_item):
            set_oauth_token(main_token)
            table_id = table_item.table_id
            try:
                thread_client = self._get_bq_client()
                full_table = thread_client.get_table(table_item.reference)

                local_gaps = []
                for field in full_table.schema:
                    # Check for native EntryLink (Deterministic CID)
                    if self._is_column_linked(dataset_id, table_id, field.name):
                        continue

                    # Check legacy BQ description for backward compatibility
                    desc = field.description or ""
                    if "Business Glossary:" not in desc:
                        local_gaps.append(
                            {
                                "Table": table_id,
                                "Column": field.name,
                                "Type": field.field_type,
                            }
                        )
                if local_gaps:
                    with lock:
                        gaps.extend(local_gaps)
            except Exception as e:
                logger.error(
                    f"Error scanning table {table_id} for glossary gaps: {e}"
                )

        with ThreadPoolExecutor(max_workers=min(len(tables), 10)) as executor:
            list(executor.map(scan_table, tables))

        return pd.DataFrame(gaps)
