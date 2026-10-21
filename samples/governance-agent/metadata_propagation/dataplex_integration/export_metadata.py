import os
import sys
import time

import google.auth
import google.auth.transport.requests
import requests
from google.cloud import bigquery, storage

# Configuration
PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = "europe-west1"
EXPORT_DATASET_ID = "governance_export"
EXPORT_TABLE_ID = "metadata_export"
GCS_BUCKET_NAME = f"{PROJECT_ID}-dataplex-export"


def get_access_token(credentials=None):
    if credentials:
        if not credentials.valid:
            request = google.auth.transport.requests.Request()
            credentials.refresh(request)
        return credentials.token

    credentials, _project = google.auth.default()
    request = google.auth.transport.requests.Request()
    credentials.refresh(request)
    return credentials.token


def create_gcs_bucket(credentials=None):
    client = storage.Client(project=PROJECT_ID, credentials=credentials)
    bucket_name = GCS_BUCKET_NAME
    try:
        client.get_bucket(bucket_name)
        print(f"Bucket {bucket_name} already exists.")
    except Exception:
        client.create_bucket(bucket_name, location=LOCATION)
        print(f"Created bucket {bucket_name} in {LOCATION}")
    return bucket_name


def run_metadata_export(credentials=None, token=None):
    access_token = token or get_access_token(credentials=credentials)
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }

    # Generate a unique job ID
    job_id = f"export-{int(time.time())}"

    data = {
        "type": "EXPORT",
        "exportSpec": {
            "outputPath": f"gs://{GCS_BUCKET_NAME}/",
            "scope": {"projects": [f"projects/{PROJECT_ID}"]},
        },
    }

    print(f"Starting metadata export job {job_id} for project {PROJECT_ID}...")
    url = f"https://dataplex.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/metadataJobs"
    response = requests.post(
        f"{url}?metadataJobId={job_id}", headers=headers, json=data
    )

    response.raise_for_status()
    job_info = response.json()
    print(f"Job started: {job_info.get('name')}")
    return job_info


def wait_for_job(job_info, credentials=None, token=None):
    if not job_info:
        return

    access_token = token or get_access_token(credentials=credentials)
    headers = {
        "Authorization": f"Bearer {access_token}",
    }

    operation_name = job_info.get("name")
    if not operation_name:
        return

    print(f"Waiting for job {operation_name} to complete...")
    url = f"https://dataplex.googleapis.com/v1/{operation_name}"

    while True:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        status = response.json()

        # Check operation status
        done = status.get("done", False)

        # Check metadata for state (optional, for logging)
        metadata = status.get("metadata", {})
        state = metadata.get("state")
        print(f"Operation done: {done}, Job state: {state}")

        if done:
            if "error" in status:
                print(f"Job failed: {status['error']}")
            else:
                print("Job completed successfully.")
            break

        print("Job still running, waiting 10 seconds...")
        time.sleep(10)

    return job_info


def create_bigquery_external_table(credentials=None):
    client = bigquery.Client(project=PROJECT_ID, credentials=credentials)

    # Create dataset if not exists
    dataset_id = f"{PROJECT_ID}.{EXPORT_DATASET_ID}"
    dataset = bigquery.Dataset(dataset_id)
    dataset.location = LOCATION
    try:
        client.get_dataset(dataset_id)
        print(f"Dataset {dataset_id} already exists.")
    except Exception:
        client.create_dataset(dataset)
        print(f"Created dataset {dataset_id}")

    table_id = f"{dataset_id}.{EXPORT_TABLE_ID}"

    # Define schema for Dataplex metadata export
    schema = [
        bigquery.SchemaField(
            "entry",
            "RECORD",
            mode="NULLABLE",
            fields=[
                bigquery.SchemaField("name", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("entryType", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("createTime", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("updateTime", "STRING", mode="NULLABLE"),
                bigquery.SchemaField("aspects", "JSON", mode="NULLABLE"),
                bigquery.SchemaField("parentEntry", "STRING", mode="NULLABLE"),
                bigquery.SchemaField(
                    "fullyQualifiedName", "STRING", mode="NULLABLE"
                ),
                bigquery.SchemaField(
                    "entrySource",
                    "RECORD",
                    mode="NULLABLE",
                    fields=[
                        bigquery.SchemaField(
                            "resource", "STRING", mode="NULLABLE"
                        ),
                        bigquery.SchemaField(
                            "system", "STRING", mode="NULLABLE"
                        ),
                        bigquery.SchemaField(
                            "platform", "STRING", mode="NULLABLE"
                        ),
                        bigquery.SchemaField(
                            "displayName", "STRING", mode="NULLABLE"
                        ),
                        bigquery.SchemaField(
                            "description", "STRING", mode="NULLABLE"
                        ),
                        bigquery.SchemaField("labels", "JSON", mode="NULLABLE"),
                        bigquery.SchemaField(
                            "ancestors",
                            "RECORD",
                            mode="REPEATED",
                            fields=[
                                bigquery.SchemaField(
                                    "name", "STRING", mode="NULLABLE"
                                ),
                                bigquery.SchemaField(
                                    "type", "STRING", mode="NULLABLE"
                                ),
                            ],
                        ),
                        bigquery.SchemaField(
                            "createTime", "STRING", mode="NULLABLE"
                        ),
                        bigquery.SchemaField(
                            "updateTime", "STRING", mode="NULLABLE"
                        ),
                        bigquery.SchemaField(
                            "location", "STRING", mode="NULLABLE"
                        ),
                    ],
                ),
            ],
        ),
    ]

    table = bigquery.Table(table_id, schema=schema)
    external_config = bigquery.ExternalConfig("NEWLINE_DELIMITED_JSON")
    external_config.source_uris = [f"gs://{GCS_BUCKET_NAME}/*"]

    # Enable Hive Partitioning to handle the nested directory structure
    hive_partitioning = bigquery.HivePartitioningOptions()
    hive_partitioning.mode = "AUTO"
    hive_partitioning.source_uri_prefix = f"gs://{GCS_BUCKET_NAME}/"
    external_config.hive_partitioning = hive_partitioning

    table.external_data_configuration = external_config

    try:
        client.delete_table(table_id)
        print(f"Deleted old table {table_id}")
    except Exception:
        pass

    client.create_table(table)
    print(
        f"Created external table {table_id} pointing to gs://{GCS_BUCKET_NAME}/*"
    )


def create_native_table(credentials=None):
    client = bigquery.Client(project=PROJECT_ID, credentials=credentials)
    dataset_id = f"{PROJECT_ID}.{EXPORT_DATASET_ID}"
    external_table_id = f"{dataset_id}.{EXPORT_TABLE_ID}"
    native_table_id = f"{dataset_id}.{EXPORT_TABLE_ID}_native"

    sql = f"""
        CREATE OR REPLACE TABLE `{native_table_id}` AS
        SELECT 
            entry.*
        FROM `{external_table_id}`
    """
    print(
        f"Creating native table {native_table_id} from {external_table_id}..."
    )
    query_job = client.query(sql)
    query_job.result()  # Wait for job to complete
    print(f"Native table {native_table_id} created.")


if __name__ == "__main__":
    if not PROJECT_ID:
        print("Please set GOOGLE_CLOUD_PROJECT environment variable.")
        sys.exit(1)

    print("Starting Dataplex Metadata Export process...")

    # 1. Create GCS bucket
    create_gcs_bucket()

    # 2. Run Metadata Export Job
    job_info = run_metadata_export()
    if job_info:
        wait_for_job(job_info)

    # 3. Create BigQuery External Table
    create_bigquery_external_table()

    # 4. Create Native BigQuery Table
    create_native_table()
