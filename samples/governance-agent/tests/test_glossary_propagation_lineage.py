import sys
import unittest
from unittest.mock import MagicMock, patch


# Mock google.adk before importing anything else
class MockBasePlugin:
    def __init__(self, name=None):
        pass


mock_adk_plugins = MagicMock()
mock_adk_plugins.base_plugin.BasePlugin = MockBasePlugin
sys.modules["google.adk"] = MagicMock()
sys.modules["google.adk.plugins"] = mock_adk_plugins
sys.modules["google.adk.plugins.base_plugin"] = mock_adk_plugins.base_plugin

# Mock context before importing plugin
with patch(
    "metadata_propagation.agent.plugins.context.get_credentials",
    return_value=MagicMock(),
):
    from metadata_propagation.agent.plugins.glossary_plugin import (
        GlossaryPlugin,
    )


class TestGlossaryPropagationLineage(unittest.TestCase):
    def setUp(self):
        # Prevent actual API calls during init
        with patch(
            "metadata_propagation.agent.plugins.context.get_credentials",
            return_value=MagicMock(),
        ):
            self.plugin = GlossaryPlugin("test-project", "europe-west1")
            self.plugin._lineage_traverser = MagicMock()
            self.plugin._similarity_engine = MagicMock()
            self.plugin._bq_client = MagicMock()
            self.plugin._glossary_client = MagicMock()
            self.plugin._ensure_initialized = MagicMock()

    def test_strict_lineage_propagation_threshold(self):
        # Scenario: Catalog link does NOT exist upstream -> Should NOT propagate via lineage, even with high similarity
        dataset_id = "ds"
        table_id = "products"

        mock_field = MagicMock()
        mock_field.name = "product_id"
        mock_field.description = "Product ID"
        mock_table = MagicMock()
        mock_table.schema = [mock_field]

        mock_upstream_field = MagicMock()
        mock_upstream_field.name = "product_id"
        mock_upstream_field.description = "Source ID"
        mock_upstream_table = MagicMock()
        mock_upstream_table.schema = [mock_upstream_field]

        def get_table_mock(ref):
            if "raw_products" in ref:
                return mock_upstream_table
            return mock_table

        self.plugin._bq_client.get_table.side_effect = get_table_mock

        # 1. Mock Lineage
        self.plugin._lineage_traverser.get_recursive_column_lineage.return_value = {
            "product_id": [
                {
                    "source_entity": "bigquery:test-project.ds.raw_products",
                    "source_column": "product_id",
                    "confidence": 1.0,
                    "hop_depth": 0,
                }
            ]
        }

        # 2. Mock Terms
        term_id = "projects/p/locations/l/glossaries/g/terms/t-sku"
        term = {
            "name": term_id,
            "display_name": "Product SKU",
            "description": "Product SKU description",
        }
        self.plugin._glossary_client.get_all_terms.return_value = [term]
        self.plugin._similarity_engine.get_ranked_suggestions.return_value = []  # No normal matches

        # 3. Test Case
        with patch.object(
            GlossaryPlugin, "_check_link_exists", return_value=False
        ):
            recs = self.plugin.recommend_terms_for_table(dataset_id, table_id)
            # Should be empty because Catalog link is False, and no similarity fallback exists in lineage path
            self.assertTrue(recs.empty)

    def test_direct_link_propagation(self):
        # Scenario: Explicit link exists on source -> should propagate regardless of similarity score
        dataset_id = "ds"
        table_id = "products"

        mock_field = MagicMock()
        mock_field.name = "product_id"
        mock_field.description = "..."
        mock_table = MagicMock()
        mock_table.schema = [mock_field]

        mock_upstream_field = MagicMock()
        mock_upstream_field.name = "product_id"
        mock_upstream_table = MagicMock()
        mock_upstream_table.schema = [mock_upstream_field]

        def get_table_mock(ref):
            if "raw_products" in ref:
                return mock_upstream_table
            return mock_table

        self.plugin._bq_client.get_table.side_effect = get_table_mock

        self.plugin._lineage_traverser.get_recursive_column_lineage.return_value = {
            "product_id": [
                {
                    "source_entity": "bigquery:test-project.ds.raw_products",
                    "source_column": "product_id",
                    "confidence": 1.0,
                    "hop_depth": 0,
                }
            ]
        }

        term = {"name": "term1", "display_name": "Term 1"}
        self.plugin._glossary_client.get_all_terms.return_value = [term]

        # Mock FOUND link
        with patch.object(
            GlossaryPlugin, "_check_link_exists", return_value=True
        ):
            recs = self.plugin.recommend_terms_for_table(dataset_id, table_id)
            self.assertFalse(recs.empty)
            self.assertEqual(recs.iloc[0]["Suggested Term"], "Term 1")


if __name__ == "__main__":
    unittest.main()
