import logging
from typing import Any

import pandas as pd
from google.adk.plugins.base_plugin import BasePlugin
from google.cloud import bigquery

from metadata_propagation.dataplex_integration.insights_connector import (
    DataInsightsClient as DescriptionPropagator,
)
from metadata_propagation.dataplex_integration.lineage_propagation import (
    LineageGraphTraverser,
    SQLFetcher,
    TransformationEnricher,
)

from .context import (
    get_credentials,
    get_oauth_token,
    is_oauth_enabled,
    set_oauth_token,
)
from .doc_description_plugin import DocDescriptionPlugin

logger = logging.getLogger(__name__)


class LineagePlugin(BasePlugin):
    def __init__(
        self,
        project_id: str,
        location: str = "europe-west1",
        knowledge_json_path: str | None = None,
    ):
        super().__init__(name="lineage_plugin")
        self.project_id = project_id
        self.location = location
        self.knowledge_json_path = knowledge_json_path
        self._lineage_traverser = None
        self._description_propagator = None
        self._sql_fetcher = None

    def _get_credentials(self):
        return get_credentials(self.project_id)

    def _get_bq_client(self):
        creds = self._get_credentials()
        return bigquery.Client(project=self.project_id, credentials=creds)

    def _ensure_initialized(self):
        creds = self._get_credentials()
        token = get_oauth_token()

        if not self._lineage_traverser:
            self._lineage_traverser = LineageGraphTraverser(
                self.project_id, self.location, token=token
            )
            if self.knowledge_json_path:
                self._lineage_traverser.load_knowledge_insights(
                    self.knowledge_json_path
                )

        if not self._description_propagator:
            self._description_propagator = DescriptionPropagator(
                self.knowledge_json_path
            )

        if not self._sql_fetcher:
            self._sql_fetcher = SQLFetcher(
                self.project_id, self.location, credentials=creds
            )

        if not hasattr(self, "_bq_client") or not self._bq_client:
            self._bq_client = self._get_bq_client()

    def scan_for_missing_descriptions(self, dataset_id: str) -> pd.DataFrame:
        """
        Scans a dataset for tables/columns missing descriptions (parallelized).
        """
        self._ensure_initialized()
        client = self._get_bq_client()
        dataset_ref = f"{self.project_id}.{dataset_id}"

        tables = list(client.list_tables(dataset_ref))
        missing_data = []

        import threading
        from concurrent.futures import ThreadPoolExecutor

        lock = threading.Lock()

        oauth_active = is_oauth_enabled()
        main_token = get_oauth_token()

        def scan_table(table_item):
            if oauth_active or main_token is not None:
                set_oauth_token(main_token)
            table_ref = f"{dataset_ref}.{table_item.table_id}"
            try:
                thread_client = self._get_bq_client()
                table = thread_client.get_table(table_ref)
                local_gaps = []
                for schema_field in table.schema:
                    if not schema_field.description:
                        local_gaps.append(
                            {
                                "Table": table_item.table_id,
                                "Column": schema_field.name,
                                "Type": schema_field.field_type,
                            }
                        )
                if local_gaps:
                    with lock:
                        missing_data.extend(local_gaps)
            except Exception as e:
                logger.error(f"Error accessing {table_ref}: {e}")

        with ThreadPoolExecutor(max_workers=min(len(tables), 10)) as executor:
            list(executor.map(scan_table, tables))

        return pd.DataFrame(missing_data)

    def _find_description_recursive(
        self,
        target_fqn: str,
        column: str,
        depth: int = 0,
        max_depth: int = 5,
        accumulated_logic: list[str] | None = None,
    ) -> dict[str, Any] | None:
        """
        Recursively searches upstream for a description, accumulating SQL logic along the way.
        """
        if accumulated_logic is None:
            accumulated_logic = []

        if depth >= max_depth:
            return None

        # 1. Get immediate upstream
        upstream = self._lineage_traverser.get_column_lineage(
            target_fqn, [column], depth=depth
        )
        sources = upstream.get(column, [])

        if not sources:
            return None

        # 2. Extract SQL logic for the CURRENT target column to help pick the best source
        logic = None
        try:
            parts = target_fqn.replace("bigquery:", "").split(".")
            if len(parts) == 3:
                ds_id, tab_id = parts[1], parts[2]
                sql = self._sql_fetcher.get_transformation_sql(ds_id, tab_id)
                if sql:
                    logic = TransformationEnricher.extract_column_logic(
                        sql, column
                    )
                    if logic:
                        accumulated_logic.append(logic)
        except Exception as e:
            logger.debug(
                f"Failed to extract intermediate SQL logic for {target_fqn}: {e}"
            )

        # 3. Select the best source (prioritize one mentioned in SQL logic)
        source = sources[0]  # Default to best by confidence
        if logic:
            logic_lower = logic.lower()
            for s in sources:
                src_col = s["source_column"].lower()
                # Check for exact word match in logic
                import re

                if re.search(rf"\b{src_col}\b", logic_lower):
                    source = s
                    source["confidence"] = max(source["confidence"], 0.7)
                    break

        # 3. Check if source has description
        src_entity = source["source_fqn"].replace("bigquery:", "")
        src_col = source["source_column"]

        try:
            client = self._get_bq_client()
            src_table = client.get_table(src_entity)
            for f in src_table.schema:
                if f.name == src_col:
                    if f.description:
                        # Found it!
                        return {
                            "source_entity": source["source_entity"],
                            "source_column": src_col,
                            "description": f.description,
                            "confidence": source["confidence"],
                            "hop_depth": depth,
                            "accumulated_logic": accumulated_logic,
                        }
                    else:
                        # No description here, keep going up
                        return self._find_description_recursive(
                            source["source_fqn"],
                            src_col,
                            depth + 1,
                            max_depth,
                            accumulated_logic,
                        )
        except Exception as e:
            logger.warning(
                f"Failed to check desc for {src_entity}.{src_col}: {e}"
            )

        return None

    def preview_propagation(
        self,
        dataset_id: str,
        target_table: str,
        document_path: list[str] | None = None,
        context_mode: str = "rag",
        datastore_id: str | None = None,
        force: bool = False,
        fallback_to_llm: bool = True,
        force_refresh: bool = False,
    ) -> pd.DataFrame:
        """
        Simulates description propagation for a specific table with multi-hop support and SQL parsing (parallelized).
        """
        self._ensure_initialized()
        target_fqn = f"bigquery:{self.project_id}.{dataset_id}.{target_table}"
        client = self._get_bq_client()
        table_ref = f"{self.project_id}.{dataset_id}.{target_table}"
        table = client.get_table(table_ref)

        candidates = []

        # 1. Load document or datastore if provided (One-time setup)
        doc_plugin = None
        if document_path or datastore_id:
            logger.info(
                f"Initializing DocDescriptionPlugin for document context / fallback in mode: {context_mode}"
            )
            doc_plugin = DocDescriptionPlugin(self.project_id, self.location)
            doc_plugin.load_document(
                document_path, mode=context_mode, datastore_id=datastore_id, force_refresh=force_refresh
            )

        logger.info(
            f"--- Parallelized Propagation Preview for {target_table} ---"
        )

        fields_to_process = []
        for field in table.schema:
            if field.description and not force:
                logger.debug(
                    f"Skipping column '{field.name}' - already has description."
                )
                continue
            fields_to_process.append(field)

        if not fields_to_process:
            return pd.DataFrame()

        # Pre-embed column queries in batch for RAG mode to avoid N sequential size 1 embedding calls
        if doc_plugin and (document_path or datastore_id):
            cols = [(f.name, f.field_type) for f in fields_to_process]
            doc_plugin.pre_embed_column_queries(target_table, cols)

        # Parallel processing of columns using ThreadPoolExecutor
        from concurrent.futures import ThreadPoolExecutor

        oauth_active = is_oauth_enabled()
        main_token = get_oauth_token()

        def process_column(field):
            if oauth_active or main_token is not None:
                set_oauth_token(main_token)

            # 1. Prioritize Document context (explicit info only)
            doc_rec = None
            if doc_plugin and (document_path or datastore_id):
                doc_rec = doc_plugin.recommend_description_for_column(
                    target_table, field.name, field.field_type, fallback=False
                )
            if doc_rec:
                return field.name, "document", doc_rec

            # 2. Fall back to Lineage
            logger.info(
                f"Searching source for column '{field.name}' via lineage..."
            )
            match = self._find_description_recursive(target_fqn, field.name)
            if match:
                logger.info(
                    f"  [FOUND Lineage] Source: {match['source_entity']}.{match['source_column']}"
                )
                enriched_desc = TransformationEnricher.enrich_description(
                    field.name,
                    match["source_column"],
                    match["description"],
                    sql_hints=match.get("accumulated_logic", []),
                )
                lineage_rec = {
                    "Target Column": field.name,
                    "Source": match["source_entity"],
                    "Source Column": match["source_column"],
                    "Confidence": match["confidence"],
                    "Proposed Description": enriched_desc,
                    "Type": f"Lineage (Hop {match['hop_depth']})"
                    if match["hop_depth"] > 0
                    else "Lineage",
                }
                return field.name, "lineage", lineage_rec

            # 3. Fall back to ungrounded LLM generation
            if fallback_to_llm and doc_plugin:
                fallback_rec = doc_plugin.recommend_description_for_column(
                    target_table, field.name, field.field_type, fallback=True
                )
                if fallback_rec:
                    return field.name, "fallback", fallback_rec

            return field.name, None, None

        with ThreadPoolExecutor(
            max_workers=min(len(fields_to_process), 10)
        ) as executor:
            results = list(executor.map(process_column, fields_to_process))

        for col_name, source_type, rec in results:
            if rec:
                candidates.append(rec)

        if not candidates:
            logger.warning(
                f"No propagation candidates found for {target_table}."
            )

        return pd.DataFrame(candidates)

    def get_lineage_summary(self, dataset_id: str, table_id: str) -> str:
        """
        Provides a holistic summary of upstream and downstream lineage.
        """
        self._ensure_initialized()
        full_table_name = f"{self.project_id}.{dataset_id}.{table_id}"
        client = self._get_bq_client()
        table = client.get_table(full_table_name)
        columns = [f.name for f in table.schema]

        # Upstream Analysis
        upstream_map = self._lineage_traverser.get_column_lineage(
            f"bigquery:{full_table_name}", columns
        )
        upstream_entities = set()
        for candidates in upstream_map.values():
            for c in candidates:
                upstream_entities.add(c["source_entity"])

        # Downstream Analysis
        downstream_map = self._lineage_traverser.get_downstream_lineage(
            f"bigquery:{full_table_name}", columns
        )
        downstream_entities = set()
        for targets in downstream_map.values():
            for t in targets:
                downstream_entities.add(t["target_entity"])

        # Fetch schemas for upstream entities to check for descriptions
        entity_descriptions = {}
        for ent in upstream_entities:
            try:
                clean_ent = ent.replace("bigquery:", "")
                src_table = client.get_table(clean_ent)
                entity_descriptions[ent] = {
                    f.name for f in src_table.schema if f.description
                }
            except Exception as e:
                logger.warning(f"Failed to fetch schema for {ent}: {e}")
                entity_descriptions[ent] = set()

        # Generate Summary Text
        summary = f"### Propagation Summary for `{table_id}`\n\n"

        if upstream_entities:
            summary += f"**Upstream Sources ({len(upstream_entities)}):**\n"
            for ent in sorted(upstream_entities):
                # Count columns that have this entity as their PRIMARY (best) source AND have descriptions
                cols = []
                for c, candidates in upstream_map.items():
                    if candidates and candidates[0]["source_entity"] == ent:
                        src_col = candidates[0]["source_column"]
                        if src_col in entity_descriptions.get(ent, set()):
                            cols.append(c)
                if cols:
                    summary += f"- `{ent}` (contributes {len(cols)} columns)\n"
                else:
                    summary += f"- `{ent}` (contributes 0 columns - missing descriptions upstream)\n"
        else:
            summary += "*No upstream sources found via Data Lineage API.*\n"

        summary += "\n"

        if downstream_entities:
            summary += f"**Downstream Targets ({len(downstream_entities)}):**\n"
            for ent in sorted(downstream_entities):
                # Count how many columns from this table flow into the downstream entity
                flowing_cols = set()
                for c, targets in downstream_map.items():
                    if any(t["target_entity"] == ent for t in targets):
                        flowing_cols.add(c)
                summary += f"- `{ent}` (receives {len(flowing_cols)} columns)\n"
        else:
            summary += "*No downstream targets found via Data Lineage API.*\n"

        summary += "\n**Propagation Potential:**\n"
        all_columns = [f.name for f in table.schema]
        missing_desc = [f.name for f in table.schema if not f.description]
        potential_inherit = len([c for c in missing_desc if c in upstream_map])

        logger.info(
            f"Summary for {table_id}: total={len(all_columns)}, missing={len(missing_desc)}, lineage_mapped={len(upstream_map)}, potential={potential_inherit}"
        )

        if not missing_desc:
            summary += (
                "✅ **This table is already fully documented in BigQuery.**\n"
            )
            if downstream_entities:
                summary += f"- Metadata from this table is ready to propagate to **{len(downstream_entities)}** downstream entities.\n"
        else:
            summary += f"- {potential_inherit} missing columns can be enriched from upstream.\n"
            if downstream_entities:
                summary += f"- Metadata from this table can propagate to {len(downstream_entities)} downstream entities.\n"

        return summary

    def apply_propagation(self, dataset_id: str, updates: list[dict[str, str]]):
        """
        Applies updates.
        updates: List of dicts with keys 'table', 'column', 'description'
        """
        self._ensure_initialized()
        client = self._get_bq_client()

        for update in updates:
            table_id = update["table"]
            col_name = update["column"]
            desc = update["description"]

            table_ref = f"{self.project_id}.{dataset_id}.{table_id}"
            table = client.get_table(table_ref)

            new_schema = []
            for field in table.schema:
                if field.name == col_name:
                    new_field = field.to_api_repr()
                    new_field["description"] = desc
                    new_schema.append(
                        bigquery.SchemaField.from_api_repr(new_field)
                    )
                else:
                    new_schema.append(field)

            table.schema = new_schema
            client.update_table(table, ["schema"])
            logger.info(f"Updated {table_id}.{col_name}")
