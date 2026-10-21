import unittest
from unittest.mock import MagicMock, patch
import pandas as pd

from metadata_propagation.agent.plugins.lineage_plugin import LineagePlugin
from metadata_propagation.agent.plugins.doc_description_plugin import (
    DocDescriptionPlugin,
)


class TestFallbackPropagation(unittest.TestCase):
    @patch("metadata_propagation.agent.plugins.lineage_plugin.get_credentials")
    @patch("metadata_propagation.agent.plugins.lineage_plugin.get_oauth_token")
    @patch("metadata_propagation.agent.plugins.context.get_credentials")
    def setUp(self, mock_ctx_creds, mock_token, mock_creds):
        # Initialize LineagePlugin with mock objects
        self.plugin = LineagePlugin(
            project_id="test-project", location="europe-west1"
        )
        self.plugin._ensure_initialized = MagicMock()
        self.plugin._get_bq_client = MagicMock()
        self.plugin._lineage_traverser = MagicMock()
        self.plugin._sql_fetcher = MagicMock()
        self.plugin._description_propagator = MagicMock()

    @patch(
        "metadata_propagation.agent.plugins.lineage_plugin.DocDescriptionPlugin"
    )
    def test_prioritized_propagation_document_wins(self, mock_doc_plugin_cls):
        # Setup mock doc plugin
        mock_doc_plugin = MagicMock()
        mock_doc_plugin_cls.return_value = mock_doc_plugin

        # Scenario: Column "col1" is in both document and lineage
        # Target table schema mock
        field = MagicMock()
        field.name = "col1"
        field.field_type = "STRING"
        field.description = ""

        mock_table = MagicMock()
        mock_table.schema = [field]

        self.plugin._get_bq_client.return_value.get_table.return_value = (
            mock_table
        )

        # Mock Lineage traversal match
        self.plugin._find_description_recursive = MagicMock(
            return_value={
                "source_entity": "proj.ds.src_table",
                "source_column": "col1",
                "description": "Lineage description",
                "confidence": 0.8,
                "hop_depth": 0,
            }
        )

        # Mock Document description match
        mock_doc_plugin.recommend_description_for_column.return_value = {
            "Target Column": "col1",
            "Proposed Description": "Document description",
            "Confidence": 0.9,
            "Source": "Document (rag)",
        }

        # Run preview
        df = self.plugin.preview_propagation(
            dataset_id="test_ds",
            target_table="test_table",
            document_path=["dummy.pdf"],
            context_mode="rag",
            fallback_to_llm=True,
        )

        # Assertions: Document description must be chosen, no lineage description row should exist
        self.assertEqual(len(df), 1)
        self.assertEqual(df.iloc[0]["Target Column"], "col1")
        self.assertEqual(
            df.iloc[0]["Proposed Description"], "Document description"
        )
        self.assertEqual(df.iloc[0]["Source"], "Document (rag)")

    @patch(
        "metadata_propagation.agent.plugins.lineage_plugin.DocDescriptionPlugin"
    )
    def test_prioritized_propagation_lineage_fallback(
        self, mock_doc_plugin_cls
    ):
        # Setup mock doc plugin
        mock_doc_plugin = MagicMock()
        mock_doc_plugin_cls.return_value = mock_doc_plugin

        # Scenario: Column "col1" has no doc description but has a lineage match
        field = MagicMock()
        field.name = "col1"
        field.field_type = "STRING"
        field.description = ""

        mock_table = MagicMock()
        mock_table.schema = [field]
        self.plugin._get_bq_client.return_value.get_table.return_value = (
            mock_table
        )

        # Mock Lineage traversal match
        self.plugin._find_description_recursive = MagicMock(
            return_value={
                "source_entity": "proj.ds.src_table",
                "source_column": "col1",
                "description": "Lineage description",
                "confidence": 0.8,
                "hop_depth": 0,
            }
        )

        # Mock Document description: None
        mock_doc_plugin.recommend_description_for_column.return_value = None

        df = self.plugin.preview_propagation(
            dataset_id="test_ds",
            target_table="test_table",
            document_path=["dummy.pdf"],
            context_mode="rag",
            fallback_to_llm=True,
        )

        # Assertions: Lineage description must be chosen
        self.assertEqual(len(df), 1)
        self.assertEqual(df.iloc[0]["Target Column"], "col1")
        self.assertEqual(
            df.iloc[0]["Proposed Description"], "Lineage description"
        )
        self.assertEqual(df.iloc[0]["Source"], "proj.ds.src_table")

    @patch(
        "metadata_propagation.agent.plugins.lineage_plugin.DocDescriptionPlugin"
    )
    def test_prioritized_propagation_llm_fallback(self, mock_doc_plugin_cls):
        # Setup mock doc plugin
        mock_doc_plugin = MagicMock()
        mock_doc_plugin_cls.return_value = mock_doc_plugin

        # Scenario: Column "col1" has no doc description and no lineage, should fall back to general LLM
        field = MagicMock()
        field.name = "col1"
        field.field_type = "STRING"
        field.description = ""

        mock_table = MagicMock()
        mock_table.schema = [field]
        self.plugin._get_bq_client.return_value.get_table.return_value = (
            mock_table
        )

        # Mock Lineage traversal: None
        self.plugin._find_description_recursive = MagicMock(return_value=None)

        # Mock Document description fallback response
        def recommend_side_effect(table_id, col_name, col_type, fallback=False):
            if fallback:
                return {
                    "Target Column": col_name,
                    "Proposed Description": "LLM fallback description",
                    "Confidence": 0.5,
                    "Source": "Fallback (LLM)",
                }
            return None

        mock_doc_plugin.recommend_description_for_column.side_effect = (
            recommend_side_effect
        )

        df = self.plugin.preview_propagation(
            dataset_id="test_ds",
            target_table="test_table",
            document_path=["dummy.pdf"],
            context_mode="rag",
            fallback_to_llm=True,
        )

        # Assertions: Fallback description must be chosen
        self.assertEqual(len(df), 1)
        self.assertEqual(df.iloc[0]["Target Column"], "col1")
        self.assertEqual(
            df.iloc[0]["Proposed Description"], "LLM fallback description"
        )
        self.assertEqual(df.iloc[0]["Source"], "Fallback (LLM)")


if __name__ == "__main__":
    unittest.main()
