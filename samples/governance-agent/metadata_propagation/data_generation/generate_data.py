import os
import random
import sys

import pandas as pd
from dotenv import load_dotenv
from faker import Faker
from google.cloud import bigquery

# Load configuration from .env
load_dotenv(override=True)

# Configuration
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
DATASET_ID = os.environ.get("BIGQUERY_DATASET_ID", "retail_syn_data")
GOVERNANCE_DATASET_ID = os.environ.get(
    "GOVERNANCE_DATASET_ID", "governance_results"
)
LOCATION = "europe-west1"

client = bigquery.Client(project=PROJECT_ID)
fake = Faker(["en_GB", "fr_FR", "de_DE", "sv_SE"])  # European locales


def create_dataset(dataset_name):
    dataset_id = f"{PROJECT_ID}.{dataset_name}"
    dataset = bigquery.Dataset(dataset_id)
    dataset.location = LOCATION
    try:
        client.get_dataset(dataset_id)
        print(f"Dataset {dataset_id} already exists.")
    except Exception:
        client.create_dataset(dataset, timeout=30)
        print(f"Created dataset {dataset_id}")


def generate_raw_customers(n=1000):
    data = []
    countries = ["en_GB", "fr_FR", "de_DE", "sv_SE"]
    for _ in range(n):
        country_code = random.choice(countries)
        fake_loc = Faker(country_code)

        # Introduce quality issues
        email = (
            fake_loc.email() if random.random() > 0.1 else None
        )  # 10% missing email
        phone = fake_loc.phone_number()
        if random.random() > 0.9:  # 10% invalid phone format
            phone = "INVALID-" + phone

        data.append(
            {
                "customer_id": fake_loc.uuid4(),
                "name": fake_loc.name(),
                "email": email,
                "phone": phone,
                "country": fake_loc.country(),
                "registration_date": fake_loc.date_between(
                    start_date="-2y", end_date="today"
                ).isoformat(),
                "card_number": fake_loc.credit_card_number(),
                "card_expiry": fake_loc.credit_card_expire(),
                "membership_level": random.choice(
                    ["Gold", "Silver", "Bronze", "Standard"]
                ),
            }
        )
    return pd.DataFrame(data)


def generate_raw_products(n=500):
    categories = ["Clothes", "Home", "Fashion Accessories"]
    data = []
    for _ in range(n):
        # Introduce quality issues
        price = round(random.uniform(5.0, 500.0), 2)
        if random.random() > 0.95:  # 5% missing price
            price = None

        data.append(
            {
                "product_id": fake.uuid4(),
                "name": fake.word().capitalize()
                + " "
                + random.choice(
                    ["Shirt", "Pants", "Chair", "Lamp", "Watch", "Bag"]
                ),
                "category": random.choice(categories),
                "price": price,
            }
        )

    # Introduce duplicates
    if n > 10:
        for _ in range(5):
            data.append(data[random.randint(0, n - 1)])

    return pd.DataFrame(data)


def generate_orders(customers_df, products_df, n=5000):
    orders_data = []
    transactions_data = []

    for _ in range(n):
        customer = customers_df.sample(1).iloc[0]
        order_id = fake.uuid4()
        order_date = fake.date_between(start_date="-1y", end_date="today")

        # Generate transactions for this order
        num_items = random.randint(1, 5)
        total_amount = 0

        for _ in range(num_items):
            product = products_df.sample(1).iloc[0]
            quantity = random.randint(1, 10)  # Varied quantity

            # Ensure price is not None/Zero for better data
            price = (
                product["price"]
                if pd.notnull(product["price"])
                else round(random.uniform(5.0, 100.0), 2)
            )
            amount = price * quantity
            total_amount += amount

            transactions_data.append(
                {
                    "transaction_id": fake.uuid4(),
                    "order_id": order_id,
                    "product_id": product["product_id"],
                    "quantity": quantity,
                    "amount": amount,
                }
            )

        orders_data.append(
            {
                "order_id": order_id,
                "customer_id": customer["customer_id"],
                "order_date": order_date.isoformat(),
                "total_amount": total_amount,
            }
        )
    return pd.DataFrame(orders_data), pd.DataFrame(transactions_data)


def load_to_bigquery(df, table_name):
    table_id = f"{PROJECT_ID}.{DATASET_ID}.{table_name}"
    job_config = bigquery.LoadJobConfig(
        write_disposition="WRITE_TRUNCATE",
    )
    job = client.load_table_from_dataframe(df, table_id, job_config=job_config)
    job.result()
    print(f"Loaded {len(df)} rows to {table_id}")


def create_derived_table(source_table, target_table, custom_query=None):
    """Creates a table using CTAS to establish lineage."""
    if custom_query:
        query = custom_query
    else:
        query = f"""
        CREATE OR REPLACE TABLE `{PROJECT_ID}.{DATASET_ID}.{target_table}` AS
        SELECT * FROM `{PROJECT_ID}.{DATASET_ID}.{source_table}`
        """

    # Execute
    job = client.query(query)
    job.result()
    print(f"Created {target_table} from {source_table} (Lineage established)")


def create_view(source_table, view_name, custom_query=None):
    """Creates a view over a source table."""
    view_id = f"{PROJECT_ID}.{DATASET_ID}.{view_name}"
    if custom_query:
        query = custom_query
    else:
        query = f"CREATE OR REPLACE VIEW `{view_id}` AS SELECT * FROM `{PROJECT_ID}.{DATASET_ID}.{source_table}`"

    # Execute
    job = client.query(query)
    job.result()
    print(f"Created view {view_name} over {source_table}")


def attach_policy_tags(table_id, column_tags: dict[str, str]):
    """Attaches policy tags to columns in a BigQuery table."""
    try:
        table = client.get_table(table_id)
        schema = list(table.schema)
        new_schema = []
        for field in schema:
            if field.name in column_tags:
                field_dict = field.to_api_repr()
                field_dict["policyTags"] = {"names": [column_tags[field.name]]}
                new_schema.append(
                    bigquery.SchemaField.from_api_repr(field_dict)
                )
            else:
                new_schema.append(field)

        table.schema = new_schema
        client.update_table(table, ["schema"])
        print(f"Attached policy tags to {table_id}: {list(column_tags.keys())}")
    except Exception as e:
        print(
            f"Warning: Failed to attach policy tags to {table_id}. Ensure tags exist. Error: {e}"
        )


def create_dq_history_table(dataset_id):
    """Creates the DQ propagation history table if it doesn't exist."""
    table_id = f"{PROJECT_ID}.{dataset_id}.dq_propagation_history"
    schema = [
        bigquery.SchemaField("table_fqn", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("column_name", "STRING", mode="REQUIRED"),
        bigquery.SchemaField("snapshot_time", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("dq_score", "FLOAT", mode="REQUIRED"),
        bigquery.SchemaField("dimensions", "STRING", mode="NULLABLE"),
        bigquery.SchemaField("source_type", "STRING", mode="NULLABLE"),
    ]
    table = bigquery.Table(table_id, schema=schema)
    try:
        client.get_table(table_id)
        print(f"Table {table_id} already exists.")
    except Exception:
        client.create_table(table)
        print(f"Created table {table_id}")


if __name__ == "__main__":
    if not PROJECT_ID:
        print("Please set GOOGLE_CLOUD_PROJECT environment variable.")
        sys.exit(1)

    create_dataset(DATASET_ID)
    create_dataset(GOVERNANCE_DATASET_ID)
    create_dq_history_table(GOVERNANCE_DATASET_ID)

    print("Generating raw data...")
    raw_customers_df = generate_raw_customers()
    raw_products_df = generate_raw_products()

    # Use raw data frames for orders generation
    orders_df, transactions_df = generate_orders(
        raw_customers_df, raw_products_df
    )

    print("Loading RAW tables to BigQuery...")
    load_to_bigquery(raw_customers_df, "raw_customers")
    load_to_bigquery(raw_products_df, "raw_products")
    load_to_bigquery(orders_df, "raw_orders")
    load_to_bigquery(transactions_df, "raw_transactions")

    print("Creating Main tables (CTAS from Raw) for Lineage...")
    create_derived_table("raw_customers", "customers")
    create_derived_table("raw_products", "products")
    create_derived_table("raw_orders", "orders")

    # Create transactions with derived fields to test lineage on transformations
    transactions_query = f"""
    CREATE OR REPLACE TABLE `{PROJECT_ID}.{DATASET_ID}.transactions` AS
    SELECT 
        t.*,
        p.category as product_category,
        o.order_date as transaction_date,
        t.amount * 0.9 as amount_discounted,
        t.amount * 1.1 as amount_taxed,
        CASE WHEN t.amount > 100 THEN 'HIGH_VALUE' ELSE 'STANDARD' END as transaction_category
    FROM `{PROJECT_ID}.{DATASET_ID}.raw_transactions` t
    LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.raw_products` p ON t.product_id = p.product_id
    LEFT JOIN `{PROJECT_ID}.{DATASET_ID}.raw_orders` o ON t.order_id = o.order_id
    """
    create_derived_table(
        "raw_transactions", "transactions", custom_query=transactions_query
    )

    print("Creating Views for Multi-Hop Lineage Testing...")
    create_view("transactions", "transactions_v")
    create_view("products", "products_v")

    print("Creating Aggregate View for Distinct Count Testing...")
    product_stats_query = f"""
    CREATE OR REPLACE VIEW `{PROJECT_ID}.{DATASET_ID}.product_stats_v` AS
    SELECT 
        category, 
        COUNT(DISTINCT product_id) as distinct_product_count
    FROM `{PROJECT_ID}.{DATASET_ID}.products`
    GROUP BY category
    """
    create_view("products", "product_stats_v", custom_query=product_stats_query)

    # --- ADDED: Policy Tag Testing Support ---
    # NOTE: Replace these with actual policy tag resource names in your environment
    POLICY_TAG_EMAIL = os.environ.get(
        "POLICY_TAG_EMAIL",
        "projects/YOUR_PROJECT/locations/YOUR_LOCATION/taxonomies/YOUR_TAXONOMY/policyTags/YOUR_EMAIL_TAG",
    )
    POLICY_TAG_CARD = os.environ.get(
        "POLICY_TAG_CARD",
        "projects/YOUR_PROJECT/locations/YOUR_LOCATION/taxonomies/YOUR_TAXONOMY/policyTags/YOUR_CARD_TAG",
    )

    if "YOUR_PROJECT" not in POLICY_TAG_EMAIL:
        print("Attaching policy tags for testing...")
        raw_cust_id = f"{PROJECT_ID}.{DATASET_ID}.raw_customers"
        attach_policy_tags(
            raw_cust_id,
            {"email": POLICY_TAG_EMAIL, "card_number": POLICY_TAG_CARD},
        )
    else:
        print(
            "\n[SKIP] Policy tag attachment skipped. Please set POLICY_TAG_EMAIL and POLICY_TAG_CARD env vars to test propagation."
        )

    print("Done.")
