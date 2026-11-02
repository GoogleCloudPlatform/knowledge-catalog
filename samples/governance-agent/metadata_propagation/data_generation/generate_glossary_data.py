import logging
import os

from google.api_core import exceptions
from google.cloud import dataplex_v1

# Configuration
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = "europe-west1"  # or your preferred region
GLOSSARY_ID = "retail-common-glossary"

logger = logging.getLogger(__name__)


def create_retail_glossary():
    client = dataplex_v1.BusinessGlossaryServiceClient()
    parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"

    glossary_name = f"{parent}/glossaries/{GLOSSARY_ID}"

    # 1. Create Glossary
    try:
        glossary = dataplex_v1.Glossary()
        glossary.display_name = "Retail Common Glossary"
        glossary.description = "Business terms for retail data domains"

        print(f"Creating glossary {GLOSSARY_ID}...")
        op = client.create_glossary(
            parent=parent, glossary=glossary, glossary_id=GLOSSARY_ID
        )
        op.result()
        print("Glossary created.")
    except exceptions.AlreadyExists:
        print(f"Glossary {GLOSSARY_ID} already exists.")

    # 2. Define Terms
    terms = [
        {
            "id": "customer-id",
            "display": "Customer Identifier",
            "desc": "Unique internal ID for a registered customer.",
        },
        {
            "id": "order-amount",
            "display": "Order Grand Total",
            "desc": "The final amount charged to the customer including taxes and discounts.",
        },
        {
            "id": "product-sku",
            "display": "Product SKU",
            "desc": "Stock Keeping Unit - unique identifier for merchandise items.",
        },
        {
            "id": "membership-tier",
            "display": "Loyalty Tier",
            "desc": "Rank of customer membership (Gold, Silver, etc.).",
        },
        {
            "id": "transaction-date",
            "display": "Transaction Timestamp",
            "desc": "The exact date and time when the order was placed.",
        },
    ]

    for t in terms:
        term_id = t["id"]
        try:
            term = dataplex_v1.GlossaryTerm()
            term.display_name = t["display"]
            term.description = t["desc"]
            term.parent = glossary_name

            print(f"Creating term {term_id}...")
            client.create_glossary_term(
                parent=glossary_name, term=term, term_id=term_id
            )
        except exceptions.AlreadyExists:
            print(f"Term {term_id} already exists.")


if __name__ == "__main__":
    if not PROJECT_ID:
        print("Please set GOOGLE_CLOUD_PROJECT.")
    else:
        create_retail_glossary()
