import os
import sys

from google.cloud import bigquery, datacatalog_v1

# Configuration
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
DATASET_ID = "retail_syn_data"
LOCATION = "europe-west1"

client = bigquery.Client(project=PROJECT_ID)
datacatalog_client = datacatalog_v1.PolicyTagManagerClient()


def create_taxonomy_and_tags():
    """Creates a taxonomy and policy tags for testing if they don't exist."""
    parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"

    # 1. Create Taxonomy
    taxonomy = datacatalog_v1.Taxonomy(
        display_name="Governance Test Taxonomy",
        description="Taxonomy for testing policy tag propagation",
        activated_policy_types=[
            datacatalog_v1.Taxonomy.PolicyType.FINE_GRAINED_ACCESS_CONTROL
        ],
    )

    try:
        # Check if already exists (simplified check by list)
        existing_taxonomies = list(
            datacatalog_client.list_taxonomies(parent=parent)
        )
        target_taxonomy = next(
            (
                t
                for t in existing_taxonomies
                if t.display_name == taxonomy.display_name
            ),
            None,
        )

        if not target_taxonomy:
            target_taxonomy = datacatalog_client.create_taxonomy(
                parent=parent, taxonomy=taxonomy
            )
            print(f"✅ Created Taxonomy: {target_taxonomy.name}")
        else:
            print(f"ℹ️ Taxonomy already exists: {target_taxonomy.name}")

        # 2. Create Policy Tags
        tags = ["PII - Email", "PII - Card Number"]
        tag_map = {}

        existing_tags = list(
            datacatalog_client.list_policy_tags(parent=target_taxonomy.name)
        )

        for tag_name in tags:
            tag_resource = next(
                (t for t in existing_tags if t.display_name == tag_name), None
            )
            if not tag_resource:
                tag = datacatalog_v1.PolicyTag(
                    display_name=tag_name,
                    description=f"Test tag for {tag_name}",
                )
                tag_resource = datacatalog_client.create_policy_tag(
                    parent=target_taxonomy.name, policy_tag=tag
                )
                print(f"✅ Created Policy Tag: {tag_resource.name}")
            else:
                print(f"ℹ️ Policy Tag already exists: {tag_resource.name}")

            # Map simplified names for attachment
            key = "email" if "Email" in tag_name else "card_number"
            tag_map[key] = tag_resource.name

        return tag_map

    except Exception as e:
        print(f"❌ Error creating taxonomy/tags: {e}")
        return {}


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
        print(
            f"✅ Successfully attached policy tags to {table_id}: {list(column_tags.keys())}"
        )
    except Exception as e:
        print(f"❌ Error: Failed to attach policy tags to {table_id}. {e}")


if __name__ == "__main__":
    if not PROJECT_ID:
        print("Error: Please set GOOGLE_CLOUD_PROJECT environment variable.")
        sys.exit(1)

    print(f"Setting up Governance Testing Environment in {PROJECT_ID}...")

    # 1. Ensure Taxonomy and Tags exist
    column_tags = create_taxonomy_and_tags()

    if not column_tags:
        print("Failed to ensure policy tags exist. Aborting attachment.")
        sys.exit(1)

    # 2. Attach to table
    target_table_id = f"{PROJECT_ID}.{DATASET_ID}.raw_customers"
    print(f"Targeting table: {target_table_id}")
    attach_policy_tags(target_table_id, column_tags)
