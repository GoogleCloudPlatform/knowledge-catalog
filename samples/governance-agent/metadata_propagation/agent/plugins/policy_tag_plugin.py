import logging
import threading

import pandas as pd
from google.adk.plugins.base_plugin import BasePlugin
from google.cloud import bigquery, bigquery_datapolicies_v1, datacatalog_v1
from google.iam.v1 import iam_policy_pb2

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


class PolicyTagPlugin(BasePlugin):
    def __init__(self, project_id: str, location: str = "europe-west1"):
        super().__init__(name="policy_tag_plugin")
        self.project_id = project_id
        self.location = location
        self._lineage_traverser = None
        self._sql_fetcher = None
        self._pt_client = None
        self._dp_client = None
        self._policy_tag_readers_cache = {}
        self._data_policy_count_cache = {}
        self._table_schema_cache = {}
        self._lock = threading.Lock()

    def _get_credentials(self):
        return get_credentials(self.project_id)

    def _get_bq_client(self):
        creds = self._get_credentials()
        return bigquery.Client(project=self.project_id, credentials=creds)

    def _get_pt_client(self):
        creds = self._get_credentials()
        return datacatalog_v1.PolicyTagManagerClient(credentials=creds)

    def _get_dp_client(self):
        creds = self._get_credentials()
        return bigquery_datapolicies_v1.DataPolicyServiceClient(
            credentials=creds
        )

    def _ensure_initialized(self):
        creds = self._get_credentials()
        token = get_oauth_token()

        if not self._lineage_traverser:
            self._lineage_traverser = LineageGraphTraverser(
                self.project_id, self.location, token=token
            )

        if not self._sql_fetcher:
            self._sql_fetcher = SQLFetcher(
                self.project_id, self.location, credentials=creds
            )

        if not self._pt_client:
            self._pt_client = self._get_pt_client()

        if not self._dp_client:
            self._dp_client = self._get_dp_client()

        if not hasattr(self, "_bq_client") or not self._bq_client:
            self._bq_client = self._get_bq_client()

    def scan_for_policy_tags(self, dataset_id: str) -> pd.DataFrame:
        """
        Scans a dataset for tables/columns with policy tags (parallelized).
        """
        self._ensure_initialized()
        client = self._get_bq_client()
        dataset_ref = f"{self.project_id}.{dataset_id}"

        tables = list(client.list_tables(dataset_ref))
        policy_tags_data = []

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
                local_tags = []
                for field in table.schema:
                    if field.policy_tags:
                        local_tags.append(
                            {
                                "Table": table_item.table_id,
                                "Column": field.name,
                                "Policy Tags": ", ".join(
                                    field.policy_tags.names
                                ),
                            }
                        )
                if local_tags:
                    with lock:
                        policy_tags_data.extend(local_tags)
            except Exception as e:
                logger.error(f"Error accessing {table_ref}: {e}")

        with ThreadPoolExecutor(max_workers=min(len(tables), 10)) as executor:
            list(executor.map(scan_table, tables))

        return pd.DataFrame(policy_tags_data)

    def get_all_policy_tags(self, location: str) -> dict[str, str]:
        """
        Fetches all policy tags in the project's taxonomies for a specific location.
        Returns a dict mapping display_name -> resource_name (full path).
        """
        self._ensure_initialized()
        creds = self._get_credentials()
        client = datacatalog_v1.PolicyTagManagerClient(credentials=creds)

        parent = f"projects/{self.project_id}/locations/{location}"
        tag_map = {}

        try:
            taxonomies = list(client.list_taxonomies(parent=parent))
            for taxonomy in taxonomies:
                tags = list(client.list_policy_tags(parent=taxonomy.name))
                for tag in tags:
                    tag_map[tag.display_name] = tag.name
        except Exception as e:
            logger.error(f"Failed to list policy tags: {e}")

        return tag_map

    def preview_policy_tag_propagation(
        self,
        dataset_id: str,
        target_table: str,
        doc_path: list[str] | None = None,
        context_mode: str = "rag",
        datastore_id: str | None = None,
    ) -> pd.DataFrame:
        """
        Recommends policy tag propagation based on lineage and documents (parallelized & optimized).
        """
        self._ensure_initialized()
        target_fqn = f"bigquery:{self.project_id}.{dataset_id}.{target_table}"
        client = self._get_bq_client()
        table_ref = f"{self.project_id}.{dataset_id}.{target_table}"
        table = client.get_table(table_ref)

        doc_plugin = None
        if doc_path:
            logger.info(
                f"Initializing DocDescriptionPlugin for Policy Tags in mode: {context_mode}"
            )
            doc_plugin = DocDescriptionPlugin(self.project_id, self.location)
            doc_plugin.load_document(
                doc_path, mode=context_mode, datastore_id=datastore_id
            )

        allowed_tags_map = {}
        if doc_path:
            # Get dataset location to match region
            dataset = client.get_dataset(f"{self.project_id}.{dataset_id}")
            allowed_tags_map = self.get_all_policy_tags(dataset.location)
            logger.info(
                f"Found {len(allowed_tags_map)} available policy tags in region {dataset.location}."
            )

        recommendations = []

        # Pre-embed column queries in batch for RAG mode to avoid N sequential size 1 embedding calls
        if doc_plugin and (doc_path or datastore_id):
            cols = [(f.name, f.field_type) for f in table.schema]
            doc_plugin.pre_embed_column_queries(target_table, cols)

        # Parallel processing of columns using ThreadPoolExecutor
        from concurrent.futures import ThreadPoolExecutor

        oauth_active = is_oauth_enabled()
        main_token = get_oauth_token()

        def process_field(field):
            if oauth_active or main_token is not None:
                set_oauth_token(main_token)
            col_recs = []
            logger.info(f"Searching source for column '{field.name}'...")
            # For policy tags, we might only care about direct upstream or a few hops
            lineage = self._lineage_traverser.get_column_lineage(
                target_fqn, [field.name], depth=0
            )
            sources = lineage.get(field.name, [])

            found_lineage = False

            for source in sources:
                src_entity = source["source_entity"]
                src_col = source["source_column"]

                try:
                    # Cache BQ table fetches thread-safely
                    with self._lock:
                        cached_table = self._table_schema_cache.get(src_entity)

                    if not cached_table:
                        thread_client = self._get_bq_client()
                        cached_table = thread_client.get_table(src_entity)
                        with self._lock:
                            self._table_schema_cache[src_entity] = cached_table

                    src_table = cached_table

                    for src_field in src_table.schema:
                        if src_field.name == src_col and src_field.policy_tags:
                            # Found a source with policy tags
                            found_lineage = True

                            # Check for transformation
                            is_straight_pull = src_col == field.name
                            logic = None
                            try:
                                sql = self._sql_fetcher.get_transformation_sql(
                                    dataset_id, target_table
                                )
                                if sql:
                                    logic = TransformationEnricher.extract_column_logic(
                                        sql, field.name
                                    )
                                    if (
                                        logic
                                        and logic.strip() != src_col
                                        and logic.strip() != f"`{src_col}`"
                                    ):
                                        is_straight_pull = False
                            except Exception as e:
                                logger.debug(f"SQL check failed: {e}")

                            recommendation = (
                                "Propagate"
                                if is_straight_pull
                                else "Review Required (Transformed)"
                            )

                            # Check if the target field already has this tag
                            src_tag_names = src_field.policy_tags.names
                            if field.policy_tags and set(
                                src_tag_names
                            ).issubset(set(field.policy_tags.names)):
                                logger.info(
                                    f"Skipping recommendation for {field.name} - tag already applied."
                                )
                                continue

                            # Fetch access summary (uses caches internally with lock protection)
                            reader_count = (
                                self.get_policy_tag_reader_count(
                                    src_tag_names[0]
                                )
                                if src_tag_names
                                else 0
                            )
                            masking_count = (
                                self.get_policy_tag_data_policy_count(
                                    src_tag_names[0]
                                )
                                if src_tag_names
                                else 0
                            )

                            col_recs.append(
                                {
                                    "Target Column": field.name,
                                    "Source Table": src_entity,
                                    "Source Column": src_col,
                                    "Policy Tags": ", ".join(src_tag_names),
                                    "Recommendation": recommendation,
                                    "Logic": logic or "Straight Pull",
                                    "Access Summary": f"{reader_count} Readers, {masking_count} Masking Policies",
                                }
                            )
                except Exception as e:
                    logger.warning(f"Failed to check source {src_entity}: {e}")

            if not found_lineage:
                logger.info(
                    f"  [NOT FOUND Lineage] No source policy tags found for '{field.name}'."
                )

            # B. Document Search
            if doc_plugin and allowed_tags_map:
                doc_rec = doc_plugin.recommend_policy_tag_for_column(
                    target_table,
                    field.name,
                    field.field_type,
                    list(allowed_tags_map.keys()),
                )
                if doc_rec:
                    if context_mode == "datastore":
                        logger.info(
                            f"  [FOUND Datastore] Policy Tag recommendation found for '{field.name}'."
                        )
                    elif context_mode == "direct":
                        logger.info(
                            f"  [FOUND Direct] Policy Tag recommendation found for '{field.name}'."
                        )
                    else:
                        logger.info(
                            f"  [FOUND RAG] Policy Tag recommendation found for '{field.name}'."
                        )
                    # Map display name back to resource path
                    resolved_tag = allowed_tags_map.get(
                        doc_rec["Proposed Tag"], doc_rec["Proposed Tag"]
                    )
                    if resolved_tag and resolved_tag.startswith("projects/"):
                        reader_count = self.get_policy_tag_reader_count(
                            resolved_tag
                        )
                        masking_count = self.get_policy_tag_data_policy_count(
                            resolved_tag
                        )
                        access_summary = f"{reader_count} Readers, {masking_count} Masking Policies"
                    else:
                        access_summary = "N/A (Tag not in taxonomy)"
                    col_recs.append(
                        {
                            "Target Column": field.name,
                            "Source Table": f"Document ({context_mode.upper()})",
                            "Source Column": "N/A",
                            "Policy Tags": resolved_tag,
                            "Recommendation": "Apply (Found in Doc)",
                            "Logic": "Explicitly labeled in document",
                            "Access Summary": access_summary,
                        }
                    )
                elif context_mode == "datastore":
                    logger.info(
                        f"  [NOT FOUND Datastore] No policy tag found for '{field.name}' in Datastore."
                    )
                elif context_mode == "direct":
                    logger.info(
                        f"  [NOT FOUND Direct] No policy tag found for '{field.name}' in document."
                    )
                else:
                    logger.info(
                        f"  [NOT FOUND RAG] No policy tag found for '{field.name}' in document."
                    )
            return col_recs

        # Process schema fields in parallel
        with ThreadPoolExecutor(
            max_workers=min(len(table.schema), 10)
        ) as executor:
            results = list(executor.map(process_field, table.schema))

        for col_recs in results:
            recommendations.extend(col_recs)

        return pd.DataFrame(recommendations)

    def get_policy_tag_reader_count(self, policy_tag_id: str) -> int:
        """Counts members with FineGrainedReader role on a policy tag (cached)."""
        with self._lock:
            if policy_tag_id in self._policy_tag_readers_cache:
                return self._policy_tag_readers_cache[policy_tag_id]

        self._ensure_initialized()
        try:
            request = iam_policy_pb2.GetIamPolicyRequest(resource=policy_tag_id)
            with self._lock:
                policy = self._pt_client.get_iam_policy(request=request)

            readers = set()
            for binding in policy.bindings:
                if (
                    binding.role
                    == "roles/datacatalog.categoryFineGrainedReader"
                ):
                    readers.update(binding.members)

            reader_count = len(readers)
            with self._lock:
                self._policy_tag_readers_cache[policy_tag_id] = reader_count
            return reader_count
        except Exception as e:
            logger.error(f"Failed to count readers for {policy_tag_id}: {e}")
            return 0

    def get_policy_tag_data_policy_count(self, policy_tag_id: str) -> int:
        """Counts BigQuery Data Policies associated with a policy tag (cached)."""
        with self._lock:
            if policy_tag_id in self._data_policy_count_cache:
                return self._data_policy_count_cache[policy_tag_id]

        self._ensure_initialized()
        try:
            parent = f"projects/{self.project_id}/locations/{self.location}"
            request = bigquery_datapolicies_v1.ListDataPoliciesRequest(
                parent=parent
            )
            with self._lock:
                page_result = self._dp_client.list_data_policies(
                    request=request
                )

            count = 0
            # Normalize target tag ID for comparison (locations/...)
            target_suffix = (
                "/".join(policy_tag_id.split("/")[2:])
                if "/" in policy_tag_id
                else policy_tag_id
            )

            with self._lock:
                for response in page_result:
                    # Normalize response tag ID
                    res_suffix = (
                        "/".join(response.policy_tag.split("/")[2:])
                        if "/" in response.policy_tag
                        else response.policy_tag
                    )

                    if res_suffix == target_suffix:
                        count += 1

            with self._lock:
                self._data_policy_count_cache[policy_tag_id] = count
            return count
        except Exception as e:
            logger.error(
                f"Failed to count data policies for {policy_tag_id}: {e}"
            )
            return 0

    def get_policy_tag_readers(self, policy_tag_id: str) -> list[str]:
        """Retrieves members with FineGrainedReader role on a policy tag."""
        self._ensure_initialized()
        try:
            request = iam_policy_pb2.GetIamPolicyRequest(resource=policy_tag_id)
            policy = self._pt_client.get_iam_policy(request=request)

            readers = []
            for binding in policy.bindings:
                if (
                    binding.role
                    == "roles/datacatalog.categoryFineGrainedReader"
                ):
                    readers.extend(binding.members)
            return readers
        except Exception as e:
            logger.error(f"Failed to get IAM policy for {policy_tag_id}: {e}")
            return []

    def set_policy_tag_readers(
        self, policy_tag_id: str, new_readers: list[str]
    ):
        """Adds members to FineGrainedReader role on a policy tag."""
        self._ensure_initialized()
        try:
            get_request = iam_policy_pb2.GetIamPolicyRequest(
                resource=policy_tag_id
            )
            policy = self._pt_client.get_iam_policy(request=get_request)

            # Find or create binding for FineGrainedReader
            found = False
            for binding in policy.bindings:
                if (
                    binding.role
                    == "roles/datacatalog.categoryFineGrainedReader"
                ):
                    # Add only new members
                    existing = set(binding.members)
                    for m in new_readers:
                        if m not in existing:
                            binding.members.append(m)
                    found = True
                    break

            if not found:
                new_binding = policy.bindings.add()
                new_binding.role = "roles/datacatalog.categoryFineGrainedReader"
                new_binding.members.extend(new_readers)

            set_request = iam_policy_pb2.SetIamPolicyRequest(
                resource=policy_tag_id, policy=policy
            )
            self._pt_client.set_iam_policy(request=set_request)
            logger.info(f"Successfully updated IAM policy for {policy_tag_id}")
        except Exception as e:
            logger.error(f"Failed to set IAM policy for {policy_tag_id}: {e}")
            raise

    def apply_policy_tags(self, dataset_id: str, updates: list[dict[str, str]]):
        """
        Applies policy tags to specified columns.
        updates: List of dicts with keys 'table', 'column', 'policy_tag'
        """
        self._ensure_initialized()
        client = self._get_bq_client()

        for update in updates:
            table_id = update["table"]
            col_name = update["column"]
            tag_name = update["policy_tag"]

            table_ref = f"{self.project_id}.{dataset_id}.{table_id}"
            try:
                table = client.get_table(table_ref)

                new_schema = []
                found = False
                for field in table.schema:
                    if field.name == col_name:
                        field_dict = field.to_api_repr()
                        field_dict["policyTags"] = {"names": [tag_name]}
                        new_schema.append(
                            bigquery.SchemaField.from_api_repr(field_dict)
                        )
                        found = True
                    else:
                        new_schema.append(field)

                if found:
                    table.schema = new_schema
                    client.update_table(table, ["schema"])
                    logger.info(
                        f"Successfully applied policy tag to {table_id}.{col_name}"
                    )

                    # Handle Access Propagation / Providing Access
                    readers = update.get("readers", [])
                    if isinstance(readers, str):
                        readers = [
                            r.strip() for r in readers.split(",") if r.strip()
                        ]

                    if readers:
                        logger.info(
                            f"Applying IAM readers to tag {tag_name}: {readers}"
                        )
                        self.set_policy_tag_readers(tag_name, readers)

                else:
                    logger.warning(f"Column {col_name} not found in {table_id}")
            except Exception as e:
                logger.error(
                    f"Failed to apply policy tag to {table_ref}.{col_name}: {e}",
                    exc_info=True,
                )
