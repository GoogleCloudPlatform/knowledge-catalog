import unittest
from unittest.mock import MagicMock, patch

import gradio as gr
import pandas as pd

from metadata_propagation.ui.gradio_app import (
    apply_glossary_selections,
    apply_propagation_improved,
)


class TestSelectiveUILogic(unittest.TestCase):
    def setUp(self):
        self.project_id = "test-project"
        self.location = "us-central1"
        self.dataset_id = "test_dataset"
        self.table_id = "test_table"

        # Mock Gradio Request
        self.mock_request = MagicMock(spec=gr.Request)
        self.mock_request.session = {
            "google_token": {"access_token": "fake-token"}
        }

    @patch("metadata_propagation.ui.gradio_app.get_plugin")
    @patch("metadata_propagation.ui.gradio_app.set_oauth_token")
    def test_apply_propagation_selective(self, mock_set_token, mock_get_plugin):
        # 1. Setup Mock Plugin
        mock_plugin = MagicMock()
        mock_get_plugin.return_value = mock_plugin

        # 2. Create sample DataFrame with selections
        data = {
            "Select": [True, False, True],
            "Target Column": ["col1", "col2", "col3"],
            "Proposed Description": ["desc1", "desc2", "desc3"],
        }
        df = pd.DataFrame(data)

        # 3. Call the function
        result = apply_propagation_improved(
            self.project_id,
            self.location,
            self.dataset_id,
            self.table_id,
            df,
            request=self.mock_request,
        )

        # 4. Assertions
        self.assertIn("Successfully applied 2 updates", result)

        # Verify plugin was called with ONLY selected updates
        called_updates = mock_plugin.apply_propagation.call_args[0][1]
        self.assertEqual(len(called_updates), 2)
        self.assertEqual(called_updates[0]["column"], "col1")
        self.assertEqual(called_updates[1]["column"], "col3")
        # Ensure col2 was NOT included
        self.assertNotIn("col2", [u["column"] for u in called_updates])

    @patch("metadata_propagation.ui.gradio_app.GlossaryPlugin")
    @patch("metadata_propagation.ui.gradio_app.set_oauth_token")
    def test_apply_glossary_selective(
        self, mock_set_token, mock_glossary_plugin_cls
    ):
        # 1. Setup Mock Plugin
        mock_plugin = MagicMock()
        mock_glossary_plugin_cls.return_value = mock_plugin

        # 2. Create sample DataFrame with selections
        data = {
            "Select": [False, True],
            "Column": ["col1", "col2"],
            "Suggested Term": ["term1", "term2"],
            "Term ID": ["id1", "id2"],
        }
        df = pd.DataFrame(data)

        # 3. Call the function
        result = apply_glossary_selections(
            self.project_id,
            self.location,
            self.dataset_id,
            self.table_id,
            df,
            request=self.mock_request,
        )

        # 4. Assertions
        self.assertIn("Successfully applied 1 glossary terms", result)

        # Verify plugin was called with ONLY selected updates
        called_updates = mock_plugin.apply_terms.call_args[0][2]
        self.assertEqual(len(called_updates), 1)
        self.assertEqual(called_updates[0]["column"], "col2")
        self.assertEqual(called_updates[0]["term_id"], "id2")

    def test_apply_propagation_no_selection(self):
        # Create DF with no selections
        df = pd.DataFrame(
            {
                "Select": [False, False],
                "Target Column": ["c1", "c2"],
                "Proposed Description": ["d1", "d2"],
            }
        )

        result = apply_propagation_improved(
            self.project_id,
            self.location,
            self.dataset_id,
            self.table_id,
            df,
            request=self.mock_request,
        )
        self.assertEqual(result, "No columns selected.")


if __name__ == "__main__":
    unittest.main()
