import unittest
from unittest.mock import MagicMock, patch

from metadata_propagation.dataplex_integration.lineage_propagation import (
    LineageGraphTraverser,
)


class TestLineageLogic(unittest.TestCase):
    def setUp(self):
        self.traverser = LineageGraphTraverser("test-project", "europe-west1")

    @patch("requests.post")
    @patch("google.auth.default")
    def test_get_column_lineage_heuristic(self, mock_auth, mock_post):
        # Mock Auth
        mock_auth.return_value = (MagicMock(), "test-project")

        # Mock API Response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "links": [
                {
                    "source": {
                        "fullyQualifiedName": "bigquery:proj.ds.src_table",
                        "field": ["order_id", "quantity", "product_id"],
                    }
                }
            ]
        }
        mock_post.return_value = mock_response

        # Test mapping for 'quantity'
        # Previous logic would pick 'order_id' as it's the first in the list.
        # New logic should pick 'quantity' due to exact match.
        results = self.traverser.get_column_lineage(
            "bigquery:proj.ds.target_table", ["quantity"]
        )

        self.assertIn("quantity", results)
        self.assertEqual(results["quantity"][0]["source_column"], "quantity")
        self.assertEqual(results["quantity"][0]["confidence"], 1.0)

        # Test mapping for 'transaction_id' which might map to 'order_id' (no exact match but single link)
        # Reset mock for next call
        mock_response.json.return_value = {
            "links": [
                {
                    "source": {
                        "fullyQualifiedName": "bigquery:proj.ds.src_table",
                        "field": ["order_id"],
                    }
                }
            ]
        }
        results = self.traverser.get_column_lineage(
            "bigquery:proj.ds.target_table", ["transaction_id"]
        )
        self.assertEqual(
            results["transaction_id"][0]["source_column"], "order_id"
        )
        self.assertEqual(results["transaction_id"][0]["confidence"], 0.7)


if __name__ == "__main__":
    unittest.main()
