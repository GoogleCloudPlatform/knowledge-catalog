from __future__ import annotations

import logging
import re
import time
from typing import Any

log = logging.getLogger(__name__)

_STRING_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")

_TERMINAL_STATES = {"SUCCEEDED", "FAILED", "CANCELLED"}
_MIN_ROWS = 1
_MAX_ROWS = 1000


class AthenaSampler:
    def __init__(
        self,
        workgroup: str = "primary",
        output_location: str | None = None,
        region: str | None = None,
        profile: str | None = None,
        athena_client: Any = None,
        poll_interval: float = 1.0,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.workgroup = workgroup
        self.output_location = output_location
        self.region = region
        self.profile = profile
        self.poll_interval = poll_interval
        self.timeout_seconds = timeout_seconds
        self._client = athena_client
        self._sleep = time.sleep

        if output_location is None:
            response = self.client.get_work_group(WorkGroup=workgroup)
            configured_location = (
                response.get("WorkGroup", {})
                .get("Configuration", {})
                .get("ResultConfiguration", {})
                .get("OutputLocation")
            )
            if not configured_location:
                raise ValueError(
                    f"Athena sampling requires an output location. Pass --athena-output-location"
                    f" or configure one on the workgroup '{workgroup}'."
                )

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3

            session = boto3.Session(profile_name=self.profile, region_name=self.region)
            self._client = session.client("athena")
        return self._client

    def sample(self, database: str, table: str, n: int = 5) -> list[dict[str, Any]] | None:
        if '"' in database or '"' in table:
            return None

        rows_wanted = max(_MIN_ROWS, min(_MAX_ROWS, int(n)))
        query = f'SELECT * FROM "{database}"."{table}" LIMIT {rows_wanted}'

        try:
            client = self.client
            start_kwargs: dict[str, Any] = {"QueryString": query, "WorkGroup": self.workgroup}
            if self.output_location:
                start_kwargs["ResultConfiguration"] = {"OutputLocation": self.output_location}
            start_response = client.start_query_execution(**start_kwargs)
            query_execution_id = start_response["QueryExecutionId"]

            state = self._poll_until_terminal(client, query_execution_id)
            if state != "SUCCEEDED":
                return None

            results = client.get_query_results(
                QueryExecutionId=query_execution_id, MaxResults=rows_wanted + 1
            )
            return self._parse_rows(results)
        except Exception:
            log.debug("Athena sample failed for %s.%s", database, table, exc_info=True)
            return None

    def _poll_until_terminal(self, client: Any, query_execution_id: str) -> str | None:
        attempts = 0
        while True:
            execution = client.get_query_execution(QueryExecutionId=query_execution_id)
            state = execution["QueryExecution"]["Status"]["State"]
            if state in _TERMINAL_STATES:
                return state

            attempts += 1
            elapsed = attempts * self.poll_interval
            if elapsed > self.timeout_seconds:
                try:
                    client.stop_query_execution(QueryExecutionId=query_execution_id)
                except Exception:
                    log.debug("Failed to stop timed-out Athena query %s", query_execution_id, exc_info=True)
                return None

            self._sleep(self.poll_interval)

    def validate(self, sql: str, *, limit: int = 1) -> str | None:
        """Run a lightweight validation query; return None on success or an error string."""
        # Strip trailing whitespace and statement terminators in either order,
        # so "SELECT 1;\n" and "SELECT 1 ;" both reduce to "SELECT 1".
        stripped = sql.strip()
        while stripped.endswith(";"):
            stripped = stripped[:-1].strip()
        if not stripped:
            return "SQL is empty."

        # Reject a semicolon that would introduce a second statement. Checked
        # against a copy with string literals blanked so a legitimate ';'
        # inside a literal is not mistaken for a terminator.
        if ";" in _STRING_LITERAL_RE.sub("''", stripped):
            return "SQL contains an embedded semicolon; only a single statement is allowed."

        first_keyword = stripped.split()[0].upper()
        if first_keyword not in ("SELECT", "WITH"):
            return f"SQL must start with SELECT or WITH (got {first_keyword!r}); DDL/DML is not allowed."

        rows_wanted = max(_MIN_ROWS, min(_MAX_ROWS, int(limit)))
        query = f"SELECT * FROM ({stripped}) LIMIT {rows_wanted}"

        try:
            client = self.client
            start_kwargs: dict[str, Any] = {"QueryString": query, "WorkGroup": self.workgroup}
            if self.output_location:
                start_kwargs["ResultConfiguration"] = {"OutputLocation": self.output_location}
            start_response = client.start_query_execution(**start_kwargs)
            query_execution_id = start_response["QueryExecutionId"]

            state = self._poll_until_terminal(client, query_execution_id)
            if state == "SUCCEEDED":
                return None
            if state is None:
                return f"Validation query timed out after {self.timeout_seconds}s."

            # FAILED or CANCELLED — try to get Athena's own error message.
            try:
                execution = client.get_query_execution(QueryExecutionId=query_execution_id)
                reason = (
                    execution["QueryExecution"]["Status"].get("StateChangeReason")
                )
            except Exception:
                reason = None
            return reason or f"Query {state.lower()} without a reason."
        except Exception as exc:
            log.debug("Athena validate failed", exc_info=True)
            return str(exc)

    @staticmethod
    def _parse_rows(results: dict[str, Any]) -> list[dict[str, Any]]:
        rows = results["ResultSet"]["Rows"]
        if not rows:
            return []

        header = [cell.get("VarCharValue") for cell in rows[0]["Data"]]
        parsed: list[dict[str, Any]] = []
        for row in rows[1:]:
            values = [cell.get("VarCharValue") for cell in row["Data"]]
            parsed.append(dict(zip(header, values)))
        return parsed
