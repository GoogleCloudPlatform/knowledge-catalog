import unittest
from unittest.mock import MagicMock

from metadata_propagation.agent.plugins.lineage_plugin import (
    LineagePlugin,
)
from metadata_propagation.dataplex_integration.lineage_propagation import (
    TransformationEnricher,
)


class TestSQLEnrichment(unittest.TestCase):
    def setUp(self):
        self.plugin = LineagePlugin("test-project", "europe-west1")
        self.plugin._get_bq_client = MagicMock()
        self.plugin._lineage_traverser = MagicMock()
        self.plugin._sql_fetcher = MagicMock()

    def test_sql_logic_extraction(self):
        sql = """
        CREATE OR REPLACE TABLE `governance-agent.retail_syn_data.transactions` AS
        SELECT 
            t.amount * 1.1 as amount_taxed,
            t.amount * 0.9 as amount_discounted,
            CASE WHEN t.amount > 100 THEN 'HIGH' ELSE 'LOW' END as val_cat
        FROM `raw_transactions` t
        """

        # Test amount_taxed
        expr = TransformationEnricher.extract_column_logic(sql, "amount_taxed")
        self.assertEqual(expr, "t.amount * 1.1")

        # Test val_cat
        expr = TransformationEnricher.extract_column_logic(sql, "val_cat")
        self.assertEqual(
            expr, "CASE WHEN t.amount > 100 THEN 'HIGH' ELSE 'LOW' END"
        )

        # Regression Test for Prefix issue: 'amount' should NOT match 'amount_discounted'
        expr_prefix = TransformationEnricher.extract_column_logic(sql, "amount")
        self.assertIsNone(
            expr_prefix,
            "Should not return logic for 'amount' when it only appears as a prefix of 'amount_discounted'",
        )

    def test_description_enrichment_with_sql(self):
        original_desc = "Total order amount"
        target_col = "amount_taxed"
        source_col = "amount"
        sql_expr = "t.amount * 1.1"

        enriched = TransformationEnricher.enrich_description(
            target_col, source_col, original_desc, sql_hints=[sql_expr]
        )

        self.assertIn("Total order amount", enriched)
        self.assertIn("value adjustment applied", enriched)

    def test_plugin_preview_with_sql(self):
        # Mock table schema
        mock_table = MagicMock()
        mock_field = MagicMock()
        mock_field.name = "amount_taxed"
        mock_field.description = ""
        mock_table.schema = [mock_field]
        self.plugin._get_bq_client().get_table.return_value = mock_table

        # Mock SQL Fetcher
        self.plugin._sql_fetcher.get_transformation_sql.return_value = (
            "SELECT t.amount * 1.1 as amount_taxed FROM t"
        )

        # Mock Recursive Lineage
        self.plugin._find_description_recursive = MagicMock(
            return_value={
                "source_entity": "raw_transactions",
                "source_column": "amount",
                "description": "Total order amount",
                "confidence": 1.0,
                "hop_depth": 0,
                "accumulated_logic": ["t.amount * 1.1"],
            }
        )

        # Run Preview
        results_df = self.plugin.preview_propagation("ds", "tab")

        # Verify
        self.assertFalse(results_df.empty)
        row = results_df.iloc[0]
        self.assertEqual(row["Target Column"], "amount_taxed")
        self.assertIn("value adjustment applied", row["Proposed Description"])

    def test_multi_hop_synthesis(self):
        # View -> Table -> Raw
        # Case: amount_taxed in View is just a passthrough from Table
        # amount_taxed in Table is a transformation from Raw.amount

        target_col = "amount_taxed"
        source_col = "amount"
        original_desc = "Base amount"

        # Hints: ['amount_taxed', 'amount * 1.1']
        # The 'amount_taxed' hint should be ignored as trivial passthrough
        # The 'amount * 1.1' should be kept
        sql_hints = [target_col, "t.amount * 1.1"]

        enriched = TransformationEnricher.enrich_description(
            target_col, source_col, original_desc, sql_hints=sql_hints
        )

        self.assertIn("Base amount", enriched)
        self.assertIn("value adjustment applied", enriched)
        # Verify it didn't add "Calculated via logic: amount_taxed"
        self.assertNotIn("logic: `amount_taxed`", enriched)


if __name__ == "__main__":
    unittest.main()
