import os

from dotenv import load_dotenv
from google.api_core import exceptions
from google.cloud import dataplex_v1

# Load configurations from .env
load_dotenv(override=True)

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "europe-west1")
DATASET_ID = os.environ.get("BIGQUERY_DATASET_ID", "retail_syn_data")
GOVERNANCE_DATASET_ID = os.environ.get(
    "GOVERNANCE_DATASET_ID", "governance_results"
)

if not PROJECT_ID:
    print(
        "⚠️ Warning: GOOGLE_CLOUD_PROJECT not found in environment or .env file."
    )


def _get_permission_help():
    """Returns a helpful gcloud command to fix common permission issues."""
    return f"""
---------------------------------------------------------
💡 PERMISSION REQUIRED:
Knowledge Catalog needs 'Fine-Grained Reader' access to the Data Catalog Taxonomy.
Run this command in your terminal to grant access:

gcloud data-catalog taxonomies add-iam-policy-binding [TAXONOMY_ID] \\
    --location={LOCATION} \\
    --member="serviceAccount:service-[PROJECT_NUMBER]@gcp-sa-dataplex.iam.gserviceaccount.com" \\
    --role="roles/datacatalog.categoryFineGrainedReader" \\
    --project={PROJECT_ID}
---------------------------------------------------------
"""


def create_dq_scan(table_name, credentials=None):
    client = dataplex_v1.DataScanServiceClient(credentials=credentials)
    parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"
    scan_id = f"dq-scan-{table_name}".replace("_", "-")

    # Define rules based on table
    rules = []
    if table_name in ["customers", "raw_customers"]:
        rules = [
            dataplex_v1.DataQualityRule(
                column="email",
                non_null_expectation={},
                dimension="COMPLETENESS",
            ),
            dataplex_v1.DataQualityRule(
                column="phone",
                regex_expectation={"regex": r"^\+?[0-9\s\-()]+$"},
                dimension="VALIDITY",
            ),
        ]
    elif table_name in ["products", "raw_products"]:
        rules = [
            dataplex_v1.DataQualityRule(
                column="price",
                non_null_expectation={},
                dimension="COMPLETENESS",
            ),
            dataplex_v1.DataQualityRule(
                column="price",
                range_expectation={"min_value": "0", "max_value": "1000"},
                dimension="VALIDITY",
            ),
        ]

    if not rules:
        print(f"No DQ rules defined for {table_name}, skipping.")
        return

    data_quality_spec = dataplex_v1.DataQualitySpec(
        rules=rules,
        post_scan_actions=dataplex_v1.DataQualitySpec.PostScanActions(
            bigquery_export=dataplex_v1.DataQualitySpec.PostScanActions.BigQueryExport(
                results_table=f"//bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{GOVERNANCE_DATASET_ID}/tables/{table_name}_dq_results"
            )
        ),
        catalog_publishing_enabled=True,
    )

    data_scan = dataplex_v1.DataScan()
    data_scan.data.resource = f"//bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{DATASET_ID}/tables/{table_name}"
    data_scan.data_quality_spec = data_quality_spec

    # Results are automatically published to Knowledge Catalog.

    try:
        operation = client.create_data_scan(
            parent=parent, data_scan=data_scan, data_scan_id=scan_id
        )
        print(f"Creating DQ scan for {table_name}...")
        operation.result()
        print(f"DQ scan created for {table_name}")
    except exceptions.AlreadyExists:
        print(f"DQ scan {scan_id} already exists, skipping creation.")
    except exceptions.InvalidArgument as e:
        if "fine-grained reader" in str(e).lower():
            print(
                "❌ Permission Error: Dataplex service account needs access to policy tags."
            )
            print(_get_permission_help())
        else:
            print(f"DQ scan failed for {table_name}: {e}")
    except Exception as e:
        print(f"DQ scan failed for {table_name}: {e}")


def create_profiling_scan(table_name, credentials=None):
    client = dataplex_v1.DataScanServiceClient(credentials=credentials)
    parent = f"projects/{PROJECT_ID}/locations/{LOCATION}"
    scan_id = f"profile-{table_name}".replace("_", "-")

    data_profile_spec = dataplex_v1.DataProfileSpec(
        post_scan_actions=dataplex_v1.DataProfileSpec.PostScanActions(
            bigquery_export=dataplex_v1.DataProfileSpec.PostScanActions.BigQueryExport(
                results_table=f"//bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{GOVERNANCE_DATASET_ID}/tables/{table_name}_profile_results"
            )
        ),
        catalog_publishing_enabled=True,
    )

    data_scan = dataplex_v1.DataScan()
    data_scan.data.resource = f"//bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{DATASET_ID}/tables/{table_name}"
    data_scan.data_profile_spec = data_profile_spec
    data_scan.type_ = "DATA_PROFILE"

    # Results are automatically published to Knowledge Catalog.

    try:
        operation = client.create_data_scan(
            parent=parent, data_scan=data_scan, data_scan_id=scan_id
        )
        print(f"Creating Profiling scan for {table_name}...")
        operation.result()
        print(f"Profiling scan created for {table_name}")
    except exceptions.AlreadyExists:
        print(f"Profiling scan {scan_id} already exists, skipping creation.")
    except exceptions.InvalidArgument as e:
        if "fine-grained reader" in str(e).lower():
            print(
                "❌ Permission Error: Dataplex service account needs access to policy tags."
            )
            print(_get_permission_help())
        else:
            print(f"Profiling scan failed for {table_name}: {e}")
    except Exception as e:
        print(f"Profiling scan failed for {table_name}: {e}")


def run_scan(scan_id, credentials=None):
    client = dataplex_v1.DataScanServiceClient(credentials=credentials)
    name = f"projects/{PROJECT_ID}/locations/{LOCATION}/dataScans/{scan_id}"
    try:
        client.run_data_scan(name=name)
        print(f"Triggered scan {scan_id}")
    except Exception as e:
        print(f"Failed to run scan {scan_id}: {e}")

    except Exception as e:
        print(f"Failed to run scan {scan_id}: {e}")
