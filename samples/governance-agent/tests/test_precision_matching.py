from metadata_propagation.agent.plugins.similarity_engine import (
    SimilarityEngine,
)


def test_precision_matching():
    engine = SimilarityEngine()

    # Test terms
    all_terms = [
        {
            "name": "terms/customer-id",
            "display_name": "Customer Identifier",
            "description": "The unique ID for customers",
        },
        {
            "name": "terms/order-id",
            "display_name": "Order ID",
            "description": "The unique ID for orders",
        },
        {
            "name": "terms/transaction-date",
            "display_name": "Transaction Timestamp",
            "description": "The date and time of the transaction",
        },
        {
            "name": "terms/order-amount",
            "display_name": "Order Grand Total",
            "description": "Total amount paid for an order including taxes and discounts",
        },
    ]

    # 1. transaction_id should NOT map to customer-id
    print("Testing transaction_id vs Customer Identifier conflict...")
    col1 = {
        "name": "transaction_id",
        "description": "Unique key for transaction records",
    }
    s1 = engine.get_ranked_suggestions(col1, all_terms)

    found_customer = False
    for s in s1:
        print(
            f"  Suggested: {s['display_name']} (Confidence: {s['confidence']})"
        )
        if s["display_name"] == "Customer Identifier":
            found_customer = True

    assert not found_customer, (
        "Customer Identifier should be suppressed for transaction_id"
    )

    # 2. order_id should map to Order ID
    print("\nTesting order_id precision...")
    col2 = {
        "name": "order_id",
        "description": "Sequential identifier for customer orders",
    }
    s2 = engine.get_ranked_suggestions(col2, all_terms)
    for s in s2:
        print(
            f"  Suggested: {s['display_name']} (Confidence: {s['confidence']})"
        )

    assert s2[0]["display_name"] == "Order ID"

    # 3. amount_discounted should map to Order Grand Total (due to amount compatibility)
    print("\nTesting amount_discounted mapping...")
    col3 = {
        "name": "amount_discounted",
        "description": "Total discount amount applied to this purchase",
    }
    s3 = engine.get_ranked_suggestions(col3, all_terms)
    for s in s3:
        print(
            f"  Suggested: {s['display_name']} (Confidence: {s['confidence']})"
        )

    assert any(s["display_name"] == "Order Grand Total" for s in s3)

    print("\nSUCCESS: Precision matching improvements verified!")


if __name__ == "__main__":
    test_precision_matching()
