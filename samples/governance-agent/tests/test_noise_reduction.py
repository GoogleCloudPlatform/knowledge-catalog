from metadata_propagation.agent.plugins.similarity_engine import (
    SimilarityEngine,
)


def test_filtering_refinement():
    engine = SimilarityEngine()

    # Mock data to simulate the screenshot
    column = {
        "name": "customer_id",
        "description": "Unique identifier for a customer",
    }

    # Mocking terms that produced noise
    all_terms = [
        {
            "name": "terms/customer-id",
            "display_name": "Customer Identifier",
            "description": "The unique ID for customers",
        },
        {
            "name": "terms/membership-tier",
            "display_name": "Loyalty Tier",
            "description": "Customer membership level",
        },
        {
            "name": "terms/transaction-date",
            "display_name": "Transaction Timestamp",
            "description": "When the order happened",
        },
        {
            "name": "terms/product-sku",
            "display_name": "Product SKU",
            "description": "Product identifier",
        },
    ]

    print("Testing noise reduction using adaptive filtering...")

    # Case: Strong match exists (Customer Identifier)
    # Suggestions should be filtered competitively
    suggestions = engine.get_ranked_suggestions(column, all_terms)

    print("\nSuggestions found:")
    for s in suggestions:
        print(f"- {s['display_name']} (Confidence: {s['confidence']})")

    names = [s["display_name"] for s in suggestions]

    assert "Customer Identifier" in names
    assert "Loyalty Tier" not in names, (
        "Loyalty Tier should have been filtered out as noise"
    )
    assert len(suggestions) < 4, "Noise filtering failed to reduce list size"

    print("\nSUCCESS: Filtering refined!")


if __name__ == "__main__":
    test_filtering_refinement()
