import logging
from typing import Any

from google.adk.plugins.base_plugin import BasePlugin
from google.cloud import bigquery, dataplex_v1
from google.protobuf.json_format import MessageToDict

from .context import get_credentials

logger = logging.getLogger(__name__)


class DQPlugin(BasePlugin):
    def __init__(self, project_id: str, location: str = "europe-west1"):
        super().__init__(name="dq_plugin")
        self.project_id = project_id
        self.location = location
        self._client = None
        self._bq_client = None

    def _get_credentials(self):
        return get_credentials(self.project_id)

    def _get_client(self):
        if not self._client:
            creds = self._get_credentials()
            self._client = dataplex_v1.DataScanServiceClient(credentials=creds)
        return self._client

    def _get_bq_client(self):
        if not self._bq_client:
            creds = self._get_credentials()
            self._bq_client = bigquery.Client(
                project=self.project_id, credentials=creds
            )
        return self._bq_client

    def _check_completeness_bq(
        self, dataset_id: str, table_name: str, column_name: str
    ) -> float | None:
        """
        Lightweight fallback to check completeness via BQ query.
        """
        client = self._get_bq_client()
        query = f"""
        SELECT 
            COUNT(*) as total,
            COUNT({column_name}) as non_null
        FROM `{self.project_id}.{dataset_id}.{table_name}`
        """
        try:
            query_job = client.query(query)
            results = list(query_job.result())
            if results:
                total = results[0].total
                non_null = results[0].non_null
                if total == 0:
                    return 1.0
                return round(non_null / total, 3)
        except Exception as e:
            logger.debug(
                f"BQ Completeness fallback failed for {table_name}.{column_name}: {e}"
            )
        return None

    def get_latest_dq_job(
        self, dataset_id: str, table_name: str
    ) -> dict[str, Any] | None:
        """
        Fetches the latest execution result for a DQ scan of a specific table.
        """
        client = self._get_client()
        parent = f"projects/{self.project_id}/locations/{self.location}"

        # Dataplex Scan ID convention from manage_scans.py
        scan_id = f"dq-scan-{table_name}".replace("_", "-")
        scan_name = f"{parent}/dataScans/{scan_id}"

        try:
            # 1. List jobs for this scan
            request = dataplex_v1.ListDataScanJobsRequest(
                parent=scan_name, page_size=1
            )
            page = client.list_data_scan_jobs(request=request)
            jobs = list(page)

            if not jobs:
                return None

            # 2. Get the full job details (including results)
            latest_job_name = jobs[0].name
            full_job_request = dataplex_v1.GetDataScanJobRequest(
                name=latest_job_name,
                view=dataplex_v1.GetDataScanJobRequest.DataScanJobView.FULL,
            )
            job = client.get_data_scan_job(request=full_job_request)

            if job.state != dataplex_v1.DataScanJob.State.SUCCEEDED:
                return None

            return MessageToDict(job._pb)
        except Exception as e:
            logger.debug(f"Missing DQ scan for {table_name}: {e}")
            return None

    def get_latest_profile_job(
        self, dataset_id: str, table_name: str
    ) -> dict[str, Any] | None:
        """
        Fetches the latest execution result for a Profiling scan.
        """
        client = self._get_client()
        parent = f"projects/{self.project_id}/locations/{self.location}"

        scan_id = f"profile-{table_name}".replace("_", "-")
        scan_name = f"{parent}/dataScans/{scan_id}"

        try:
            request = dataplex_v1.ListDataScanJobsRequest(
                parent=scan_name, page_size=1
            )
            jobs = list(client.list_data_scan_jobs(request=request))

            if not jobs:
                return None

            full_job_request = dataplex_v1.GetDataScanJobRequest(
                name=jobs[0].name,
                view=dataplex_v1.GetDataScanJobRequest.DataScanJobView.FULL,
            )
            job = client.get_data_scan_job(request=full_job_request)

            if job.state != dataplex_v1.DataScanJob.State.SUCCEEDED:
                return None

            return MessageToDict(job._pb)
        except Exception as e:
            logger.debug(f"Missing Profiling scan for {table_name}: {e}")
            return None

    def fetch_dq_summary(
        self, dataset_id: str, table_name: str, column_name: str | None = None
    ) -> dict[str, Any]:
        """
        Main entry point for UI/CLI to get a 0.0-1.0 summary score for a table or specific column.
        """
        # 1. Try Auto-DQ
        dq_job = self.get_latest_dq_job(dataset_id, table_name)
        if dq_job:
            dq_result = dq_job.get("dataQualityResult", {})
            passed = dq_result.get("passed", False)

            # Enrich with dimension-level scores
            dimensions = {}
            for dim in dq_result.get("dimensions", []):
                dim_name = dim.get("dimension")
                if isinstance(dim_name, dict):
                    # Fallback if somehow it's a dict
                    dim_name = str(dim_name.get("name", "Unknown"))

                dim_name = str(dim_name) if dim_name else "Unknown"
                dim_passed = dim.get("passed", False)
                dimensions[dim_name] = 1.0 if dim_passed else 0.3

            score = 1.0 if passed else 0.5

            # If column-specific, try to find relevant rule results
            if column_name:
                rules = dq_result.get("rules", [])
                col_rules = [
                    r
                    for r in rules
                    if r.get("rule", {}).get("column") == column_name
                ]
                if col_rules:
                    passed_count = sum(
                        1 for r in col_rules if r.get("passed", False)
                    )
                    score = passed_count / len(col_rules)

            return {
                "source": "AUTO_DQ",
                "score": score,
                "dimensions": dimensions,
                "job_time": dq_job.get("endTime"),
            }

        # 2. Try Profiling Fallback
        profile_job = self.get_latest_profile_job(dataset_id, table_name)
        if profile_job:
            profile_result = profile_job.get("dataProfileResult", {})
            score = 0.8  # Default successful profile score
            dimensions = {"Completeness": 0.8}

            if column_name:
                # Peek into field profiles
                fields = profile_result.get("profile", {}).get("fields", [])
                col_profile = next(
                    (f for f in fields if f.get("name") == column_name), None
                )
                if col_profile:
                    null_ratio = col_profile.get("nullRatio", 0)
                    score = 1.0 - null_ratio
                    dimensions["Completeness"] = score
                    if "distinctRatio" in col_profile:
                        dimensions["Uniqueness"] = col_profile["distinctRatio"]

            return {
                "source": "PROFILING",
                "score": score,
                "dimensions": dimensions,
                "job_time": profile_job.get("endTime"),
            }

        # 3. BigQuery Fallback (Only if column specified)
        if column_name:
            bq_score = self._check_completeness_bq(
                dataset_id, table_name, column_name
            )
            if bq_score is not None:
                return {
                    "source": "BQ_FALLBACK",
                    "score": bq_score,
                    "dimensions": {"Completeness": bq_score},
                    "job_time": None,
                }

        # 4. Default (No scan data)
        return {
            "source": "UNKNOWN",
            "score": 0.0,
            "dimensions": {},
            "job_time": None,
        }
