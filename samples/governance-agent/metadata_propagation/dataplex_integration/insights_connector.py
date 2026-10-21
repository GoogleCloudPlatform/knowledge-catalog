import json
import time
from typing import Any

from dotenv import load_dotenv
from google.api_core.exceptions import NotFound
from google.cloud import bigquery, dataplex_v1
from google.protobuf.json_format import MessageToDict

# Load configuration from .env
load_dotenv(override=True)


class DataInsightsClient:
    """
    Unified client for Dataplex Data Documentation scans.
    Supports both Table-level and Dataset-level insights.
    """

    def __init__(self, project_id: str, location: str = "europe-west1"):
        self.project_id = project_id
        self.location = location
        self.dataplex_client = dataplex_v1.DataScanServiceClient()
        self.bq_client = bigquery.Client(project=project_id)

    def _get_resource_fqn(
        self, dataset_id: str, table_id: str | None = None
    ) -> str:
        if table_id:
            return f"//bigquery.googleapis.com/projects/{self.project_id}/datasets/{dataset_id}/tables/{table_id}"
        return f"//bigquery.googleapis.com/projects/{self.project_id}/datasets/{dataset_id}"

    def _get_scan_id(self, dataset_id: str, table_id: str | None = None) -> str:
        if table_id:
            return f"doc-scan-{table_id.replace('_', '-')}"
        return f"doc-scan-dataset-{dataset_id.replace('_', '-')}"

    def ensure_publishing_labels(
        self, dataset_id: str, table_id: str | None = None
    ):
        """Ensures the BQ resource has the labels required for Dataplex publishing."""
        scan_id = self._get_scan_id(dataset_id, table_id)
        updates = {
            "dataplex-data-documentation-published-scan": scan_id,
            "dataplex-data-documentation-published-project": self.project_id,
            "dataplex-data-documentation-published-location": self.location,
        }

        try:
            if table_id:
                table_ref = f"{self.project_id}.{dataset_id}.{table_id}"
                resource = self.bq_client.get_table(table_ref)
                labels = resource.labels or {}
            else:
                dataset_ref = f"{self.project_id}.{dataset_id}"
                resource = self.bq_client.get_dataset(dataset_ref)
                labels = resource.labels or {}

            needs_update = False
            for k, v in updates.items():
                if labels.get(k) != v:
                    labels[k] = v
                    needs_update = True

            if needs_update:
                resource.labels = labels
                if table_id:
                    self.bq_client.update_table(resource, ["labels"])
                else:
                    self.bq_client.update_dataset(resource, ["labels"])
                print(f"Updated labels for {table_id or dataset_id}")
        except Exception as e:
            print(
                f"Warning: Failed to update labels for {table_id or dataset_id}: {e}"
            )

    def create_and_start_scan(
        self, dataset_id: str, table_id: str | None = None
    ) -> str | None:
        """Creates (if needed) and triggers a documentation scan."""
        parent = f"projects/{self.project_id}/locations/{self.location}"
        scan_id = self._get_scan_id(dataset_id, table_id)
        scan_name = f"{parent}/dataScans/{scan_id}"

        try:
            self.dataplex_client.get_data_scan(name=scan_name)
        except NotFound:
            print(f"Creating scan: {scan_id}")
            data_scan = dataplex_v1.DataScan()
            data_scan.data.resource = self._get_resource_fqn(
                dataset_id, table_id
            )
            data_scan.execution_spec.trigger.on_demand = {}
            data_scan.type_ = dataplex_v1.DataScanType.DATA_DOCUMENTATION
            data_scan.data_documentation_spec = {}

            op = self.dataplex_client.create_data_scan(
                parent=parent, data_scan=data_scan, data_scan_id=scan_id
            )
            op.result()

        self.ensure_publishing_labels(dataset_id, table_id)

        print(f"Starting scan job for {table_id or dataset_id}...")
        try:
            run_response = self.dataplex_client.run_data_scan(name=scan_name)
            return run_response.job.name
        except Exception as e:
            print(f"Error starting scan: {e}")
            return None

    def wait_for_job(
        self, job_name: str, timeout_sec: int = 600
    ) -> dict[str, Any] | None:
        """Polls a Dataplex job until completion and returns the FULL result dict."""
        print(f"Waiting for job {job_name.rsplit('/', maxsplit=1)[-1]}...")
        start_time = time.time()

        while (time.time() - start_time) < timeout_sec:
            request = dataplex_v1.GetDataScanJobRequest(
                name=job_name,
                view=dataplex_v1.GetDataScanJobRequest.DataScanJobView.FULL,
            )
            job = self.dataplex_client.get_data_scan_job(request=request)

            if job.state in [
                dataplex_v1.DataScanJob.State.SUCCEEDED,
                dataplex_v1.DataScanJob.State.FAILED,
                dataplex_v1.DataScanJob.State.CANCELLED,
            ]:
                print(f"Job finished with state: {job.state.name}")
                if job.state == dataplex_v1.DataScanJob.State.SUCCEEDED:
                    return MessageToDict(job._pb)
                return None
            time.sleep(15)

        print("Timeout waiting for scan job.")
        return None

    def extract_insights(
        self, job_dict: dict[str, Any], table_name: str | None = None
    ) -> dict[str, Any]:
        """Flatten Dataplex DataDocumentationResult into our knowledge format."""
        result = job_dict.get("dataDocumentationResult", {})
        relationships = []

        # 1. Table-level descriptions (from tableResult)
        table_res = result.get("tableResult", {})
        if table_res:
            target_table = table_name or table_res.get("name", "unknown")
            table_overview = table_res.get("overview", "")

            # Map columns
            schema_data = table_res.get("schema", {})
            columns = []
            if isinstance(schema_data, dict):
                columns = schema_data.get("fields", [])
            elif isinstance(schema_data, list):
                columns = schema_data

            column_mappings = []
            for col in columns:
                if isinstance(col, dict) and col.get("name"):
                    column_mappings.append(
                        {
                            "target_col": col.get("name"),
                            "source_col": col.get("name"),
                            "confidence": 1.0,
                            "type": "DATAPLEX_INSIGHT",
                            "explanation": col.get("description", ""),
                        }
                    )

            relationships.append(
                {
                    "target_table": target_table,
                    "source_table": "DATAPLEX_AI",
                    "table_overview": table_overview,
                    "column_mappings": column_mappings,
                }
            )

        # 2. Dataset-level relationships (lineage hints)
        dataset_res = result.get("datasetResult", {})
        if dataset_res:
            # Handle schemaRelationships if available
            pass

        return {"relationships": relationships}

    def run_full_sync(
        self,
        dataset_id: str,
        table_id: str | None = None,
        output_file: str = "knowledge_insights.json",
    ):
        """Triggers, waits, and extracts insights for a single resource."""
        job_name = self.create_and_start_scan(dataset_id, table_id)
        if not job_name:
            return None

        job_dict = self.wait_for_job(job_name)
        if not job_dict:
            return None

        insights = self.extract_insights(job_dict, table_name=table_id)

        # Merge if output file exists? No, overwrite for now to keep it clean.
        with open(output_file, "w") as f:
            json.dump(insights, f, indent=2)
        print(f"Insights saved to {output_file}")
        return insights
