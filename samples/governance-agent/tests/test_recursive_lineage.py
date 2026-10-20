import unittest
from unittest.mock import MagicMock

from metadata_propagation.agent.plugins.lineage_plugin import (
    LineagePlugin,
)


class TestRecursiveLineage(unittest.TestCase):
    def setUp(self):
        self.plugin = LineagePlugin("test-project", "europe-west1")
        # Mock dependencies
        self.plugin._get_bq_client = MagicMock()
        self.plugin._lineage_traverser = MagicMock()

    def test_recursive_discovery(self):
        # Setup mocks for a 3-table chain: A -> B -> C
        # Table C schema (no description)
        mock_table_c = MagicMock()
        mock_field_c = MagicMock()
        mock_field_c.name = "order_id"
        mock_field_c.description = ""
        mock_table_c.schema = [mock_field_c]

        # Table B schema (no description)
        mock_table_b = MagicMock()
        mock_field_b = MagicMock()
        mock_field_b.name = "order_id"
        mock_field_b.description = ""
        mock_table_b.schema = [mock_field_b]

        # Table A schema (has description)
        mock_table_a = MagicMock()
        mock_field_a = MagicMock()
        mock_field_a.name = (
            "ordered_id"  # slightly different name to test enrichment
        )
        mock_field_a.description = "The unique identifier for an order"
        mock_table_a.schema = [mock_field_a]

        # Mock BQ client's get_table
        def get_table_mock(ref):
            if "table_c" in ref:
                return mock_table_c
            if "table_b" in ref:
                return mock_table_b
            if "table_a" in ref:
                return mock_table_a
            raise Exception("Table not found")

        self.plugin._get_bq_client().get_table.side_effect = get_table_mock

        # Mock Lineage Traversal
        def get_lineage_mock(target_fqn, columns, depth=0):
            if "table_c" in target_fqn:
                return {
                    "order_id": [
                        {
                            "source_fqn": "bigquery:test-project.ds.table_b",
                            "source_entity": "table_b",
                            "source_column": "order_id",
                            "confidence": 1.0,
                        }
                    ]
                }
            if "table_b" in target_fqn:
                return {
                    "order_id": [
                        {
                            "source_fqn": "bigquery:test-project.ds.table_a",
                            "source_entity": "table_a",
                            "source_column": "ordered_id",
                            "confidence": 0.95,
                        }
                    ]
                }
            return {}

        self.plugin._lineage_traverser.get_column_lineage.side_effect = (
            get_lineage_mock
        )

        # Run Preview
        results_df = self.plugin.preview_propagation("ds", "table_c")

        # Verify
        self.assertFalse(results_df.empty)
        self.assertEqual(len(results_df), 1)
        row = results_df.iloc[0]
        self.assertEqual(row["Target Column"], "order_id")
        self.assertEqual(row["Source"], "table_a")
        self.assertEqual(
            row["Proposed Description"], "The unique identifier for an order"
        )
        self.assertEqual(
            row["Type"], "Lineage (Hop 1)"
        )  # C -> B is Hop 0, B -> A is Hop 1


if __name__ == "__main__":
    unittest.main()
