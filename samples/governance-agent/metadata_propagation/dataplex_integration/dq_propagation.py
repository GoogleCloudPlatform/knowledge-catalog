import datetime
import json
import logging
import os
from typing import Any

from .lineage_propagation import (
    LineageGraphTraverser,
    SQLFetcher,
    TransformationEnricher,
)

logger = logging.getLogger(__name__)


class DQPropagationEngine:
    def __init__(
        self, project_id: str, location: str, token: str | None = None
    ):
        self.project_id = project_id
        self.location = location
        self.token = token
        self._traverser = LineageGraphTraverser(
            project_id, location, token=token
        )
        self._sql_fetcher = None  # Lazy load
        self.bq_history_table = "dq_propagation_history"
        self.dataset_id = os.environ.get(
            "GOVERNANCE_DATASET_ID", "governance_results"
        )

    def _get_sql_fetcher(self):
        if not self._sql_fetcher:
            from metadata_propagation.agent.plugins.context import (
                get_credentials,
            )

            self._sql_fetcher = SQLFetcher(
                self.project_id,
                self.location,
                credentials=get_credentials(self.project_id),
            )
        return self._sql_fetcher

    def get_column_dq_lineage(
        self, target_fqn: str, columns: list[str], max_depth: int = 3
    ) -> dict[str, Any]:
        """
        Traverses upstream to find the DQ sources for each column (multi-hop).
        """
        return self._traverser.get_recursive_column_lineage(
            target_fqn, columns, max_depth=max_depth
        )

    def detect_remediation(
        self, target_dataset: str, target_table: str, column: str
    ) -> float:
        """
        Analyzes the transformation SQL for a column to detect quality repair logic.
        Returns a 'remediation bonus' (e.g., 0.1 for improvement).
        """
        sql = self._get_sql_fetcher().get_transformation_sql(
            target_dataset, target_table
        )
        if not sql:
            return 0.0

        logic = TransformationEnricher.extract_column_logic(sql, column)
        if not logic:
            return 0.0

        logic_upper = logic.upper()
        bonus = 0.0

        # 1. Uniqueness remediation
        if "DISTINCT " in logic_upper or "ROW_NUMBER()" in logic_upper:
            bonus += 0.1

        # 2. Completeness remediation
        if any(
            kw in logic_upper for kw in ["COALESCE", "IFNULL", "NULLIF", "CASE"]
        ):
            bonus += 0.1

        # 3. Validity remediation
        if (
            "SAFE." in logic_upper
            or "CAST(" in logic_upper
            or "REGEXP_REPLACE" in logic_upper
        ):
            bonus += 0.05

        return min(bonus, 0.3)  # Max bonus capped at 0.3

    def aggregate_scores(
        self, upstream_scores: list[float], method: str = "conservative_min"
    ) -> float:
        """
        Aggregates upstream scores into a single derived score.
        """
        if not upstream_scores:
            return 0.0

        if method == "conservative_min":
            return min(upstream_scores)

        if method == "weighted_avg":
            # Simple average for now, could be enhanced with importance metadata
            return sum(upstream_scores) / len(upstream_scores)

        return sum(upstream_scores) / len(upstream_scores)

    def update_history(
        self,
        fqn: str,
        column: str,
        score: float,
        source_type: str = "DERIVED",
        dimensions: dict[str, float] | None = None,
    ):
        """
        Persists data quality history directly to BigQuery.
        """
        try:
            from google.cloud import bigquery

            from metadata_propagation.agent.plugins.context import (
                get_credentials,
            )

            client = bigquery.Client(
                project=self.project_id,
                credentials=get_credentials(self.project_id),
            )

            table_id = (
                f"{self.project_id}.{self.dataset_id}.{self.bq_history_table}"
            )

            row = {
                "table_fqn": fqn,
                "column_name": column,
                "snapshot_time": datetime.datetime.now().isoformat(),
                "dq_score": score,
                "dimensions": json.dumps(dimensions) if dimensions else "{}",
                "source_type": source_type,
            }

            errors = client.insert_rows_json(table_id, [row])
            if errors:
                logger.warning(
                    f"Failed to insert row into BQ DQ history: {errors}"
                )
        except Exception as e:
            logger.warning(f"Error persisting DQ history to BQ: {e}")

    def get_trend(self, fqn: str, column: str) -> str:
        """
        Calculates the trend based on history retrieved from BigQuery.
        """
        try:
            from google.cloud import bigquery

            from metadata_propagation.agent.plugins.context import (
                get_credentials,
            )

            client = bigquery.Client(
                project=self.project_id,
                credentials=get_credentials(self.project_id),
            )
            table_id = (
                f"{self.project_id}.{self.dataset_id}.{self.bq_history_table}"
            )

            query = f"""
                SELECT dq_score
                FROM `{table_id}`
                WHERE table_fqn = @fqn AND column_name = @column
                ORDER BY snapshot_time DESC
                LIMIT 5
            """

            job_config = bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("fqn", "STRING", fqn),
                    bigquery.ScalarQueryParameter("column", "STRING", column),
                ]
            )

            query_job = client.query(query, job_config=job_config)
            snapshots = [row.dq_score for row in query_job]

            if len(snapshots) < 2:
                return "stable"

            current = snapshots[0]
            previous = sum(snapshots[1:]) / (len(snapshots) - 1)

            if current > previous + 0.05:
                return "improving"
            if current < previous - 0.05:
                return "degrading"
            return "stable"

        except Exception as e:
            logger.warning(f"Error calculating trend from BQ: {e}")
            return "stable"

    def propagate_dq_scores(
        self,
        target_fqn: str,
        dataset_id: str,
        table_name: str,
        columns: list[str],
    ):
        """
        Performs full recursive DQ propagation for a set of columns.
        Returns a mapping of column names to their derived score details.
        """
        # 1. Resolve multi-hop lineage
        lineage_map = self.get_column_dq_lineage(target_fqn, columns)

        results = {}
        for col in columns:
            # Find leaf sources for this column
            all_mappings = lineage_map.get(col, [])

            # Group by hop depth to process remediation step-by-step or find leaves
            # For simplicity, we find the "furthest" sources (Max depth)
            if not all_mappings:
                # No upstream, likely a raw table itself or missing lineage
                # We handle this by returning a default/lookup in CLI, but here we'll markers it
                results[col] = {
                    "score": 0.0,
                    "source_type": "UNKNOWN",
                    "bonus": 0.0,
                }
                continue

            max_hop = max(m["hop_depth"] for m in all_mappings)
            leaves = [m for m in all_mappings if m["hop_depth"] == max_hop]

            # Detect remediation at the target view level
            bonus = self.detect_remediation(dataset_id, table_name, col)

            results[col] = {
                "leaves": leaves,
                "bonus": bonus,
                "hop_depth": max_hop,
            }

        return results
