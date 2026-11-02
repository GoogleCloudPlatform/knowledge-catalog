import json
import logging

from google.api_core import exceptions
from google.cloud import storage


def load_metadata(gcs_uri: str):
    """Loads metadata from a GCS URI."""
    if not gcs_uri:
        return {"error": "GCS URI is required."}
    try:
        storage_client = storage.Client()
        bucket_name, blob_name = gcs_uri.replace("gs://", "").split("/", 1)
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        content = blob.download_as_string()
        metadata = [
            json.loads(line)
            for line in content.decode("utf-8").splitlines()
            if line.strip()
        ]
        return metadata
    except exceptions.NotFound:
        return {"error": f"The file at GCS URI {gcs_uri} was not found."}
    except Exception as e:
        return {"error": f"An unexpected error occurred: {e}"}


def get_content_from_gcs_for_schema(gcs_uri: str) -> dict:
    """
    Gets the content of a file from GCS for schema generation.
    If the URI is a directory, it uses the first file found in it.

    Args:
        gcs_uri (str): The GCS URI of the file or directory.

    Returns:
        dict: A dictionary with 'status' and either 'content' or 'error_message'.
    """
    schema_gcs_uri = gcs_uri
    try:
        storage_client = storage.Client()
        gcs_path = gcs_uri.replace("gs://", "")
        path_parts = gcs_path.split("/", 1)
        bucket_name = path_parts[0]
        blob_prefix = path_parts[1] if len(path_parts) > 1 else ""
        bucket = storage_client.bucket(bucket_name)
        is_directory = blob_prefix.endswith("/") or blob_prefix == ""

        if is_directory:
            blobs = list(
                storage_client.list_blobs(
                    bucket, prefix=blob_prefix, max_results=10
                )
            )
            files_in_dir = [
                f"gs://{bucket_name}/{b.name}"
                for b in blobs
                if not b.name.endswith("/")
            ]

            if not files_in_dir:
                return {
                    "status": "error",
                    "error_message": f"No files found in GCS directory {gcs_uri} to generate schema.",
                }
            schema_gcs_uri = files_in_dir[0]
            logging.info(
                f"Directory detected. Using first file for schema: {schema_gcs_uri}"
            )

    except Exception as e:
        return {
            "status": "error",
            "error_message": f"Error accessing GCS URI {gcs_uri}: {e}",
        }

    try:
        bucket_name, blob_name = schema_gcs_uri.replace("gs://", "").split(
            "/", 1
        )
        bucket = storage_client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        content = blob.download_as_string().decode("utf-8")
        return {"status": "success", "content": content}
    except Exception as e:
        return {
            "status": "error",
            "error_message": f"Error downloading file {schema_gcs_uri} for schema generation: {e}",
        }
