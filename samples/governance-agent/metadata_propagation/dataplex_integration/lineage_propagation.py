import json
import logging
import re
import threading
from typing import Any

import google.auth
import google.auth.transport.requests
import requests
from google.cloud import bigquery

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class SQLFetcher:
    """
    Fetches transformation SQL from BigQuery Information Schema.
    This allows the propagation engine to understand HOW a column was derived.
    """

    def __init__(
        self, project_id: str, location: str, credentials: Any | None = None
    ):
        self.project_id = project_id
        self.location = location
        self.client = bigquery.Client(
            project=project_id, credentials=credentials
        )
        self._sql_cache = {}  # Cache: (dataset_id, table_id) -> query_text
        self._lock = threading.Lock()

    def get_transformation_sql(
        self, dataset_id: str, table_id: str
    ) -> str | None:
        """Queries Information Schema for the last SQL job that updated this table (cached & thread-safe)."""
        cache_key = (dataset_id, table_id)
        with self._lock:
            if cache_key in self._sql_cache:
                return self._sql_cache[cache_key]

        with self._lock:
            # Double-checked locking pattern
            if cache_key in self._sql_cache:
                return self._sql_cache[cache_key]

            # NOTE: BigQuery Information Schema Jobs views are regional.
            # We must query the specific region where the processing happened.
            region = self.location.split("-")[0]  # approximate region mapping
            if "europe" in self.location:
                region = "europe-west1"  # handle europe specific multi-region/regional variation

            query = f"""
            SELECT query
            FROM `{self.project_id}.region-{region}.INFORMATION_SCHEMA.JOBS_BY_PROJECT`
            WHERE destination_table.table_id = '{table_id}'
            AND destination_table.dataset_id = '{dataset_id}'
            AND statement_type IN ('CREATE_TABLE_AS_SELECT', 'INSERT', 'MERGE', 'UPDATE')
            ORDER BY creation_time DESC
            LIMIT 1
            """
            try:
                query_job = self.client.query(query)
                results = list(query_job.result())
                if results:
                    sql_query = results[0].query
                    self._sql_cache[cache_key] = sql_query
                    return sql_query
            except Exception as e:
                logger.warning(f"Failed to fetch SQL for {table_id}: {e}")

            self._sql_cache[cache_key] = None
            return None


class TransformationEnricher:
    """Provides semantic enrichment logic for propagated metadata."""

    @staticmethod
    def check_semantic_mismatch(target_col: str, source_col: str) -> float:
        """Applies penalties if column semantics seem way off."""
        target_lower = target_col.lower()
        source_lower = source_col.lower()

        # Date vs ID mismatch
        if "date" in target_lower and "id" in source_lower:
            return 0.1
        if "id" in target_lower and "date" in source_lower:
            return 0.1

        # Amount vs Flag mismatch
        if "amount" in target_lower and (
            "flag" in source_lower or "is_" in source_lower
        ):
            return 0.2

        # Category/Name vs ID mismatch
        if (
            "category" in target_lower or "name" in target_lower
        ) and "id" in source_lower:
            return 0.1
        if "id" in target_lower and (
            "category" in source_lower or "name" in source_lower
        ):
            return 0.1

        # Category/Name vs Amount mismatch
        if (
            "category" in target_lower or "name" in target_lower
        ) and "amount" in source_lower:
            return 0.1
        if "amount" in target_lower and (
            "category" in source_lower or "name" in source_lower
        ):
            return 0.1

        # Category/Name vs Date mismatch
        if (
            "category" in target_lower or "name" in target_lower
        ) and "date" in source_lower:
            return 0.1
        if "date" in target_lower and (
            "category" in source_lower or "name" in source_lower
        ):
            return 0.1

        # Amount vs ID mismatch
        if "amount" in target_lower and "id" in source_lower:
            return 0.1
        if "id" in target_lower and "amount" in source_lower:
            return 0.1

        # Quantity vs Identity/Amount/Date mismatch
        if "quantity" in target_lower and any(
            kw in source_lower for kw in ["id", "amount", "date", "name"]
        ):
            return 0.1
        if "quantity" in source_lower and any(
            kw in target_lower for kw in ["id", "amount", "date", "name"]
        ):
            return 0.1

        # ID vs ID mismatch (prefix conflict)
        if "id" in target_lower and "id" in source_lower:
            # Extract prefixes (everything before '_id' or 'id')
            def get_id_prefix(s):
                for suffix in ["_id", "id"]:
                    if s.endswith(suffix):
                        return s[: -len(suffix)].strip("_")
                return s

            target_prefix = get_id_prefix(target_lower)
            source_prefix = get_id_prefix(source_lower)

            # If prefixes exist and are fundamentally different (and not common aliases)
            if (
                target_prefix
                and source_prefix
                and target_prefix != source_prefix
            ):
                common_aliases = [
                    {"order", "transaction"},
                    {"item", "product"},
                    {"customer", "user"},
                ]
                is_alias = False
                for pair in common_aliases:
                    if {target_prefix, source_prefix}.issubset(pair):
                        is_alias = True
                        break

                if not is_alias:
                    return 0.1

        return 1.0

    @staticmethod
    def extract_column_logic(sql: str, target_col: str) -> str | None:
        """Attempts to extract the expression for a specific column from SQL SELECT."""
        if not sql:
            return None

        # Simple cleanup
        sql_clean = re.sub(r"--.*", "", sql)  # remove comments
        sql_clean = re.sub(r"\s+", " ", sql_clean).strip()

        # Look for SELECT ... AS target_col or SELECT target_col AS ...
        # New pattern: ALSO match 'SELECT ... {target_col},' or 'SELECT ... {target_col} FROM' handles passthrough
        pattern_as = rf"([^,]*?)\s+as\s+`?\b{target_col}\b`?"
        match = re.search(pattern_as, sql_clean, re.IGNORECASE)

        if not match:
            # Fallback for simple passthrough (no AS): SELECT col, or SELECT ... , col, or SELECT col FROM
            pattern_passthrough = rf"(\b{target_col}\b)(?:,|$|\s+FROM)"
            match = re.search(pattern_passthrough, sql_clean, re.IGNORECASE)

        if match:
            expr = match.group(1).strip()
            # If it's a passthrough, we need the whole SELECT part if there's a DISTINCT
            if "DISTINCT " in sql_clean.upper() and expr == target_col:
                expr = f"DISTINCT {expr}"

            # Clean up leading SELECT if present
            last_select = re.split(r"\bSELECT\b", expr, flags=re.IGNORECASE)[-1]
            return last_select.strip()

        return None

    @staticmethod
    def describe_sql_logic(expr: str | None) -> str:
        """Converts SQL expression into natural language hint."""
        if not expr:
            return ""

        expr_upper = expr.upper()

        # 1. Type Conversion
        if "CAST(" in expr_upper or "SAFE_CAST(" in expr_upper:
            return f", converted to a different format (`{expr}`)"

        # 2. Null Handling
        if any(kw in expr_upper for kw in ["COALESCE(", "IFNULL(", "NULLIF("]):
            return f", with null-handling logic (`{expr}`)"

        # 3. Numerical Operations
        if any(
            kw in expr_upper for kw in ["ROUND(", "CEIL(", "FLOOR(", "TRUNC("]
        ):
            return f", rounded using `{expr}`"

        if any(op in expr for op in ["*", "/", "+", "-"]) and any(
            char.isdigit() for char in expr
        ):
            return f", with value adjustment applied (calculated as `{expr}`)"

        # 4. String Formatting
        if any(
            kw in expr_upper
            for kw in ["UPPER(", "LOWER(", "TRIM(", "CONCAT(", "SUBSTR("]
        ):
            return f", with string transformations (`{expr}`)"

        # 5. Date/Time Extractions
        if "EXTRACT(" in expr_upper:
            return f", with temporal component extracted via `{expr}`"

        # 6. Logical Branching
        if "CASE" in expr_upper or "IF(" in expr_upper:
            return f", determined by conditional logic (`{expr}`)"

        # 7. Safe Execution
        if "SAFE." in expr_upper:
            return f", executed with safe-mode operations (`{expr}`)"

        return f", calculated using: `{expr}`"

    @staticmethod
    def enrich_description(
        target_col: str,
        source_col: str,
        original_desc: str,
        sql_hints: list[str] | None = None,
    ) -> str:
        """Builds a polished description combining source and multi-hop transformation context."""
        explanation = ""
        target_lower = target_col.lower()

        # Determine fallback explanation if original_desc is empty
        if any(
            kw in target_lower
            for kw in ["amount", "price", "cost", "discount", "tax"]
        ):
            explanation = "Monetary value."
        elif any(kw in target_lower for kw in ["date", "timestamp", "time"]):
            explanation = "Temporal attribute."
        elif any(kw in target_lower for kw in ["category", "type", "status"]):
            explanation = "Classification or status indicator."

        # Start with the best available description
        description = original_desc or explanation or ""

        # Clean up any trailing periods to allow smoother concatenation
        description = description.strip()
        if description.endswith("."):
            description = description[:-1]

        # Clean up the Insights prefix if it exists in the original description from an upstream schema
        prefix_to_remove = "Propagated via Dataset Insights: "
        if description.startswith(prefix_to_remove):
            description = description[len(prefix_to_remove) :].strip()

        # Add source context if significantly different - REMOVED AS PER USER REQUEST
        # The source is already tracked in separate columns
        pass

        # Add SQL logic context from all hops
        if sql_hints:
            # Filter out trivial passthroughs (where hint is just the column name or table.column)
            meaningful_hints = []
            for hint in sql_hints:
                # Trivial if it's just 'col', 'alias.col', or '`col`'
                is_trivial = (
                    re.match(r"^[\w\.]+$", hint)
                    or hint.strip() == f"`{target_col}`"
                )
                if not is_trivial:
                    meaningful_hints.append(hint)

            for hint in meaningful_hints:
                logic_hint = TransformationEnricher.describe_sql_logic(hint)
                if logic_hint.strip() and logic_hint not in description:
                    description += logic_hint

        return description.strip()


class LineageGraphTraverser:
    # Class-level lineage cache shared across all instances/plugins
    _global_lineage_cache = {}
    _global_lock = threading.Lock()

    @classmethod
    def clear_global_cache(cls):
        """Clears the unified shared lineage cache."""
        with cls._global_lock:
            cls._global_lineage_cache.clear()
            logger.info("Unified Lineage Cache cleared successfully.")

    def __init__(self, project_id, location, token: str | None = None):
        self.project_id = project_id
        self.location = location
        self.token = token
        # Note: lineage lookups use the REST API in _search_links with the
        # caller's OAuth token. No ADC-backed client is created here.
        self.knowledge_insights = []

    def load_knowledge_insights(self, json_path):
        """Loads Knowledge Engine insights (schema relationships) from JSON."""
        try:
            with open(json_path) as f:
                data = json.load(f)
                # The unified format uses 'relationships' at the top level
                # Each relationship has target_table, column_mappings, etc.
                self.knowledge_insights = data.get("relationships", [])
                logger.info(
                    f"Loaded {len(self.knowledge_insights)} relationships from {json_path}"
                )
        except FileNotFoundError:
            logger.warning(f"Insights file {json_path} not found. Skipping.")
        except Exception as e:
            logger.warning(f"Failed to load insights from {json_path}: {e}")

    def _normalize_fqn(self, fqn):
        """
        Normalizes various FQN formats to 'project.dataset.table'.
        """
        if not fqn:
            return ""
        if fqn.startswith("//bigquery.googleapis.com/"):
            # //bigquery.googleapis.com/projects/P/datasets/D/tables/T
            parts = fqn.split("/")
            # parts indices: 4=project, 6=dataset, 8=table
            if len(parts) >= 9:
                return f"{parts[4]}.{parts[6]}.{parts[8]}"
        elif "/entryGroups/" in fqn and "/entries/" in fqn:
            # projects/P/locations/L/entryGroups/G/entries/bigquery.googleapis.com/projects/P/datasets/D/tables/T
            parts = fqn.split("/")
            if "bigquery.googleapis.com" in parts:
                idx = parts.index("bigquery.googleapis.com")
                # Look for project name after 'projects'
                p_name, d_name, t_name = "", "", ""
                for i in range(idx, len(parts) - 1):
                    if parts[i] == "projects" and not p_name:
                        p_name = parts[i + 1]
                    if parts[i] == "datasets" and not d_name:
                        d_name = parts[i + 1]
                    if parts[i] == "tables" and not t_name:
                        t_name = parts[i + 1]

                if p_name and d_name and t_name:
                    return f"{p_name}.{d_name}.{t_name}"
        elif fqn.startswith("bigquery:"):
            return fqn.replace("bigquery:", "")
        return fqn

    def _search_links(self, fqn, fields=None, search_type="target"):
        """
        Helper to call Data Lineage API searchLinks.
        search_type: "target" for upstream, "source" for downstream.
        """
        token = self.token
        if isinstance(token, dict):
            token = token.get("access_token")

        if not token:
            from metadata_propagation.agent.plugins.context import (
                get_credentials,
                get_oauth_token,
                is_oauth_enabled,
            )

            token = get_oauth_token()
            if not token:
                if is_oauth_enabled():
                    creds = get_credentials(self.project_id)
                    token = getattr(creds, "token", None)
                else:
                    # Fallback to ADC only when OAuth is not enabled
                    credentials, _project = google.auth.default()
                    auth_req = google.auth.transport.requests.Request()
                    credentials.refresh(auth_req)
                    token = credentials.token

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
        }

        parent = f"projects/{self.project_id}/locations/{self.location}"
        url = f"https://{self.location}-datalineage.googleapis.com/v1/{parent}:searchLinks"

        body = {search_type: {"fullyQualifiedName": fqn}}
        if fields:
            body[search_type]["field"] = fields

        response = requests.post(url, headers=headers, json=body)
        response.raise_for_status()
        return response.json().get("links", [])

    def get_column_lineage(
        self, target_entry_name, target_columns, depth=0, max_depth=3
    ):
        """
        Fetches upstream column lineage for a given target entry.
        Supports recursive lookup (multi-hop) up to max_depth.
        """
        if depth >= max_depth:
            return {}

        column_mappings = {}

        for col in target_columns:
            cache_key = (target_entry_name, col)
            with self._global_lock:
                if cache_key in self._global_lineage_cache:
                    column_mappings[col] = self._global_lineage_cache[cache_key]
                    continue

            logger.info(
                f"Searching upstream column lineage for {target_entry_name}.{col} (depth {depth})..."
            )
            try:
                links = self._search_links(target_entry_name, [col], "target")
                if not links:
                    column_mappings[col] = []
                    with self._global_lock:
                        self._global_lineage_cache[cache_key] = []
                    continue

                matches = []
                for link in links:
                    source = link.get("source", {})
                    source_fqn = source.get("fullyQualifiedName")
                    source_fields = source.get("field", [])

                    if not source_fqn or not source_fields:
                        continue

                    for src_field in source_fields:
                        score = 0.1
                        if src_field == col:
                            score = 1.0
                        elif src_field.lower() == col.lower():
                            score = 0.95
                        elif src_field.replace("_", "") == col.replace("_", ""):
                            score = 0.9
                        elif col in src_field or src_field in col:
                            score = 0.8
                        elif len(source_fields) == 1:
                            score = 0.7

                        penalty = (
                            TransformationEnricher.check_semantic_mismatch(
                                col, src_field
                            )
                        )
                        score = score * penalty

                        if (
                            score >= 0.05
                        ):  # Threshold for considering as valid lineage (allowing penalized links for structural enrichment)
                            matches.append(
                                {
                                    "source_fqn": source_fqn,
                                    "source_entity": self._normalize_fqn(
                                        source_fqn
                                    ),
                                    "source_column": src_field,
                                    "confidence": round(score, 2),
                                    "semantic_penalty": True
                                    if penalty < 1.0
                                    else False,
                                    "hop_depth": depth,
                                }
                            )

                if matches:
                    # Sort candidates by confidence
                    sorted_matches = sorted(
                        matches, key=lambda x: x["confidence"], reverse=True
                    )
                    column_mappings[col] = sorted_matches
                    with self._global_lock:
                        self._global_lineage_cache[cache_key] = sorted_matches
                else:
                    column_mappings[col] = []
                    with self._global_lock:
                        self._global_lineage_cache[cache_key] = []

            except Exception as e:
                logger.warning(
                    f"Failed to fetch upstream lineage for column {col}: {e}"
                )
                column_mappings[col] = []

        return column_mappings

    def _resolve_single_column_lineage(self, target_entry_name, col, max_depth):
        """Resolves lineage recursively for a single column."""
        to_explore = [(target_entry_name, col, 0)]
        seen_nodes = set()
        paths = []

        while to_explore:
            curr_ent, curr_col, depth = to_explore.pop(0)
            if depth >= max_depth:
                continue

            mappings = self.get_column_lineage(
                curr_ent, [curr_col], depth=depth, max_depth=max_depth
            )
            for m in mappings.get(curr_col, []):
                # Avoid cycles or repeat work
                node_id = (m["source_fqn"], m["source_column"])
                if node_id not in seen_nodes:
                    seen_nodes.add(node_id)
                    paths.append(m)
                    # Add to queue for deeper exploration
                    to_explore.append(
                        (m["source_fqn"], m["source_column"], depth + 1)
                    )
        return col, paths

    def get_recursive_column_lineage(
        self, target_entry_name, target_columns, max_depth=3
    ):
        """
        Resolves lineage multi-hop (Table -> View -> View) and explores branching paths in parallel.
        Returns a map: target_col -> list of all unique ancestor mappings found.
        """
        from concurrent.futures import ThreadPoolExecutor

        final_paths = {}
        logger.info(
            f"Searching upstream column lineage for {target_entry_name} columns {target_columns} (depth 0) in parallel..."
        )

        with ThreadPoolExecutor(
            max_workers=min(len(target_columns), 10)
        ) as executor:
            futures = [
                executor.submit(
                    self._resolve_single_column_lineage,
                    target_entry_name,
                    col,
                    max_depth,
                )
                for col in target_columns
            ]
            for fut in futures:
                try:
                    col, paths = fut.result()
                    final_paths[col] = paths
                except Exception as e:
                    logger.warning(
                        f"Failed to resolve lineage for a column: {e}"
                    )

        return final_paths

    def get_downstream_lineage(self, source_entry_name, source_columns):
        """
        Fetches downstream column lineage, optionally using Knowledge Engine insights.
        """
        logger.info(f"Searching downstream lineage for {source_entry_name}...")
        downstream_mappings = {}  # Source Col -> List of Targets
        norm_source = self._normalize_fqn(source_entry_name)

        for col in source_columns:
            targets = []
            try:
                # 1. Standard Lineage API
                links = self._search_links(source_entry_name, [col], "source")
                for link in links:
                    target = link.get("target", {})
                    target_fqn = target.get("fullyQualifiedName")
                    target_fields = target.get("field", [])

                    if target_fqn and target_fields:
                        targets.append(
                            {
                                "target_fqn": target_fqn,
                                "target_entity": target_fqn.split(":")[-1]
                                if ":" in target_fqn
                                else target_fqn,
                                "target_column": target_fields[0],
                            }
                        )

            except Exception as e:
                logger.warning(
                    f"Failed to fetch downstream lineage for column {col}: {e}"
                )

            # 2. Check Knowledge Engine Insights
            if self.knowledge_insights:
                for rel in self.knowledge_insights:
                    left_fqn = self._normalize_fqn(
                        rel.get("leftSchemaPaths", {}).get("tableFqn", "")
                    )
                    right_fqn = self._normalize_fqn(
                        rel.get("rightSchemaPaths", {}).get("tableFqn", "")
                    )
                    left_cols = rel.get("leftSchemaPaths", {}).get("paths", [])
                    right_cols = rel.get("rightSchemaPaths", {}).get(
                        "paths", []
                    )

                    if left_fqn == norm_source and col in left_cols:
                        if right_cols:
                            target_col = right_cols[0]
                            existing = any(
                                t["target_entity"] == right_fqn
                                and t["target_column"] == target_col
                                for t in targets
                            )
                            if not existing:
                                targets.append(
                                    {
                                        "target_fqn": right_fqn,
                                        "target_entity": right_fqn.split(".")[
                                            -1
                                        ],
                                        "target_column": target_col,
                                        "source": "KNOWLEDGE_ENGINE",
                                    }
                                )

            if targets:
                downstream_mappings[col] = targets

        return downstream_mappings


class DerivationIdentifier:
    @staticmethod
    def identify_pattern(source_col, target_col, logic=None):
        """
        Identifies if it's DIRECT_COPY, RENAME, or TRANSFORM.
        """
        if logic:
            return "TRANSFORM"

        if source_col == target_col:
            return "DIRECT_COPY"

        return "RENAME"
