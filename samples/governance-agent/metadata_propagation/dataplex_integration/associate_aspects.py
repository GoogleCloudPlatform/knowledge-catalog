import os
import sys

from google.cloud import dataplex_v1
from google.protobuf import struct_pb2

# Configuration
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = "europe-west1"  # For Aspect Types
BQ_LOCATION = "europe-west1"  # For BigQuery entries
DATASET_ID = "retail_syn_data"


def create_aspect_type():
    client = dataplex_v1.CatalogServiceClient()
    parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"
    aspect_type_id = "data-governance-aspect"

    aspect_type = dataplex_v1.AspectType()
    aspect_type.description = "Governance metadata for Retail data"
    aspect_type.metadata_template = dataplex_v1.AspectType.MetadataTemplate()
    aspect_type.metadata_template.name = "governance_info"
    aspect_type.metadata_template.type = "RECORD"

    # Add fields to aspect type
    field_owner = dataplex_v1.AspectType.MetadataTemplate()
    field_owner.name = "owner"
    field_owner.type = "STRING"
    field_owner.constraints.required = True
    field_owner.index = 1

    field_pii = dataplex_v1.AspectType.MetadataTemplate()
    field_pii.name = "contains_pii"
    field_pii.type = "BOOL"
    field_pii.index = 2

    field_layer = dataplex_v1.AspectType.MetadataTemplate()
    field_layer.name = "layer"
    field_layer.type = "STRING"  # Values: raw, datalake
    field_layer.index = 3

    field_env = dataplex_v1.AspectType.MetadataTemplate()
    field_env.name = "environment"
    field_env.type = "STRING"  # Values: UAT, Prod
    field_env.index = 4

    aspect_type.metadata_template.record_fields.extend(
        [field_owner, field_pii, field_layer, field_env]
    )

    try:
        operation = client.create_aspect_type(
            parent=parent,
            aspect_type_id=aspect_type_id,
            aspect_type=aspect_type,
        )
        print(f"Creating aspect type {aspect_type_id}...")
        operation.result()
        print("Aspect type created.")
    except Exception as e:
        print(f"Aspect type might already exist: {e}")
    return f"projects/{PROJECT_ID}/locations/{LOCATION}/aspectTypes/{aspect_type_id}"


def get_entry_name_from_bq_table(project_id, dataset_id, table_id):
    # Directly construct the entry name
    entry_id = f"bigquery.googleapis.com/projects/{project_id}/datasets/{dataset_id}/tables/{table_id}"
    entry_name = f"projects/{project_id}/locations/{BQ_LOCATION}/entryGroups/@bigquery/entries/{entry_id}"
    return entry_name


def tag_table(
    table_name, aspect_type_name, owner, contains_pii, layer, environment="Prod"
):
    client = dataplex_v1.CatalogServiceClient()

    entry_name = get_entry_name_from_bq_table(
        PROJECT_ID, DATASET_ID, table_name
    )
    if not entry_name:
        print(f"Could not find harvested entry for {table_name}, skipping.")
        return

    aspect_data = struct_pb2.Struct()
    aspect_data.update(
        {
            "owner": owner,
            "contains_pii": contains_pii,
            "layer": layer,
            "environment": environment,
        }
    )

    entry = dataplex_v1.Entry()
    entry.name = entry_name

    # Parse aspect type name to get the correct key format for the aspects map
    parts = aspect_type_name.split("/")
    if len(parts) >= 6:
        project = parts[1]
        location = parts[3]
        aspect_type_id = parts[5]
        aspect_key = f"{project}.{location}.{aspect_type_id}"
    else:
        aspect_key = aspect_type_name

    entry.aspects = {
        aspect_key: dataplex_v1.Aspect(
            aspect_type=aspect_type_name, data=aspect_data
        )
    }

    try:
        client.update_entry(entry=entry, update_mask={"paths": ["aspects"]})
        print(f"Updated harvested entry and tagged {table_name}")
    except Exception as e:
        print(f"Failed to update entry for {table_name}: {e}")


if __name__ == "__main__":
    if not PROJECT_ID:
        print("Please set GOOGLE_CLOUD_PROJECT environment variable.")
        sys.exit(1)

    aspect_type_name = create_aspect_type()

    tag_table("customers", aspect_type_name, "Data Privacy Team", True, "raw")
    tag_table("products", aspect_type_name, "Merchandising Team", False, "raw")
    tag_table("orders", aspect_type_name, "Sales Team", False, "datalake")
    tag_table(
        "transactions", aspect_type_name, "Finance Team", False, "datalake"
    )
