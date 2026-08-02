from __future__ import annotations

from typing import Any

from aws_reference_agent.sources.athena import AthenaSampler


class FakeAthenaClient:
    def __init__(
        self,
        states: list[str] | None = None,
        rows: list[dict[str, Any]] | None = None,
        start_query_error: Exception | None = None,
        state_change_reason: str | None = None,
    ) -> None:
        self.states = states if states is not None else ["SUCCEEDED"]
        self.rows = rows if rows is not None else []
        self.start_query_error = start_query_error
        self.state_change_reason = state_change_reason
        self.start_calls: list[dict[str, Any]] = []
        self.stop_calls: list[str] = []
        self.get_query_results_calls: list[dict[str, Any]] = []
        self._poll_index = 0

    def start_query_execution(self, **kwargs: Any) -> dict[str, Any]:
        self.start_calls.append(kwargs)
        if self.start_query_error is not None:
            raise self.start_query_error
        return {"QueryExecutionId": "abc-123"}

    def get_query_execution(self, **kwargs: Any) -> dict[str, Any]:
        idx = min(self._poll_index, len(self.states) - 1)
        state = self.states[idx]
        self._poll_index += 1
        status: dict[str, Any] = {"State": state}
        if self.state_change_reason is not None:
            status["StateChangeReason"] = self.state_change_reason
        return {"QueryExecution": {"Status": status}}

    def get_query_results(self, **kwargs: Any) -> dict[str, Any]:
        self.get_query_results_calls.append(kwargs)
        return {"ResultSet": {"Rows": self.rows}}

    def stop_query_execution(self, **kwargs: Any) -> dict[str, Any]:
        self.stop_calls.append(kwargs.get("QueryExecutionId", ""))
        return {}

    def get_work_group(self, WorkGroup: str) -> dict[str, Any]:
        return {
            "WorkGroup": {
                "Configuration": {
                    "ResultConfiguration": {"OutputLocation": "s3://fake-bucket/output/"}
                }
            }
        }


def _row(*cells: dict[str, Any] | None) -> dict[str, Any]:
    return {"Data": [c if c is not None else {} for c in cells]}


def test_should_return_parsed_rows_with_header_stripped_when_query_succeeds():
    header = _row({"VarCharValue": "id"}, {"VarCharValue": "name"})
    data = _row({"VarCharValue": "1"}, {"VarCharValue": "alice"})
    client = FakeAthenaClient(rows=[header, data])
    sampler = AthenaSampler(athena_client=client)

    result = sampler.sample("db", "tbl", n=1)

    assert result == [{"id": "1", "name": "alice"}]


def test_should_map_missing_varcharvalue_to_none_when_cell_is_null():
    header = _row({"VarCharValue": "id"}, {"VarCharValue": "name"})
    data = _row({"VarCharValue": "1"}, None)
    client = FakeAthenaClient(rows=[header, data])
    sampler = AthenaSampler(athena_client=client)

    result = sampler.sample("db", "tbl", n=1)

    assert result == [{"id": "1", "name": None}]


def test_should_return_none_when_state_is_failed():
    client = FakeAthenaClient(states=["FAILED"])
    sampler = AthenaSampler(athena_client=client)

    assert sampler.sample("db", "tbl") is None


def test_should_return_none_when_state_is_cancelled():
    client = FakeAthenaClient(states=["CANCELLED"])
    sampler = AthenaSampler(athena_client=client)

    assert sampler.sample("db", "tbl") is None


def test_should_return_none_and_stop_query_when_polling_exceeds_timeout():
    client = FakeAthenaClient(states=["RUNNING", "RUNNING", "RUNNING", "RUNNING"])
    sleeps: list[float] = []
    sampler = AthenaSampler(
        athena_client=client,
        poll_interval=0.01,
        timeout_seconds=0.02,
    )
    sampler._sleep = sleeps.append  # type: ignore[method-assign]

    result = sampler.sample("db", "tbl")

    assert result is None
    assert client.stop_calls == ["abc-123"]


def test_should_omit_result_configuration_when_output_location_is_none():
    client = FakeAthenaClient(rows=[_row({"VarCharValue": "id"})])
    sampler = AthenaSampler(athena_client=client, output_location=None)

    sampler.sample("db", "tbl")

    assert "ResultConfiguration" not in client.start_calls[0]


def test_should_include_result_configuration_when_output_location_is_set():
    client = FakeAthenaClient(rows=[_row({"VarCharValue": "id"})])
    sampler = AthenaSampler(athena_client=client, output_location="s3://bucket/prefix/")

    sampler.sample("db", "tbl")

    assert client.start_calls[0]["ResultConfiguration"] == {
        "OutputLocation": "s3://bucket/prefix/"
    }


def test_should_return_none_when_table_name_contains_double_quote():
    client = FakeAthenaClient()
    sampler = AthenaSampler(athena_client=client)

    result = sampler.sample("db", 'tbl"; DROP TABLE x')

    assert result is None
    assert client.start_calls == []


def test_should_return_none_when_database_name_contains_double_quote():
    client = FakeAthenaClient()
    sampler = AthenaSampler(athena_client=client)

    result = sampler.sample('db"', "tbl")

    assert result is None
    assert client.start_calls == []


def test_should_return_none_when_start_query_execution_raises():
    client = FakeAthenaClient(start_query_error=RuntimeError("boom"))
    sampler = AthenaSampler(athena_client=client)

    assert sampler.sample("db", "tbl") is None


def test_should_clamp_n_and_build_expected_query_string():
    client = FakeAthenaClient(rows=[_row({"VarCharValue": "id"})])
    sampler = AthenaSampler(athena_client=client, workgroup="wg")

    sampler.sample("db", "tbl", n=10000)

    assert client.start_calls[0]["QueryString"] == 'SELECT * FROM "db"."tbl" LIMIT 1000'
    assert client.start_calls[0]["WorkGroup"] == "wg"


def test_should_not_touch_boto3_when_client_is_injected():
    client = FakeAthenaClient(rows=[_row({"VarCharValue": "id"})])
    sampler = AthenaSampler(athena_client=client)

    result = sampler.sample("db", "tbl")

    assert result is not None


# ---------------------------------------------------------------------------
# AthenaSampler.validate tests
# ---------------------------------------------------------------------------


def test_should_return_none_when_validate_query_succeeds():
    client = FakeAthenaClient(states=["SUCCEEDED"])
    sampler = AthenaSampler(athena_client=client)

    assert sampler.validate("SELECT 1") is None


def test_should_build_wrapped_query_for_select_without_semicolon():
    client = FakeAthenaClient(states=["SUCCEEDED"])
    sampler = AthenaSampler(athena_client=client)

    sampler.validate("SELECT 1")

    assert client.start_calls[0]["QueryString"] == "SELECT * FROM (SELECT 1) LIMIT 1"


def test_should_strip_trailing_semicolon_and_build_wrapped_query():
    client = FakeAthenaClient(states=["SUCCEEDED"])
    sampler = AthenaSampler(athena_client=client)

    sampler.validate("SELECT 1;")

    assert client.start_calls[0]["QueryString"] == "SELECT * FROM (SELECT 1) LIMIT 1"


def test_should_strip_semicolon_when_followed_by_trailing_whitespace():
    client = FakeAthenaClient(states=["SUCCEEDED"])
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate("SELECT 1;  \n")

    assert result is None
    assert client.start_calls[0]["QueryString"] == "SELECT * FROM (SELECT 1) LIMIT 1"


def test_should_accept_query_when_semicolon_appears_inside_a_string_literal():
    client = FakeAthenaClient(states=["SUCCEEDED"])
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate("SELECT split(col, ';') FROM t")

    assert result is None
    assert client.start_calls != []


def test_should_accept_query_when_it_starts_with_a_with_clause():
    client = FakeAthenaClient(states=["SUCCEEDED"])
    sampler = AthenaSampler(athena_client=client)

    assert sampler.validate("WITH c AS (SELECT 1) SELECT * FROM c") is None


def test_should_return_error_without_aws_call_when_sql_is_only_a_semicolon():
    client = FakeAthenaClient()
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate(";")

    assert result is not None
    assert client.start_calls == []


def test_should_return_state_change_reason_when_query_fails():
    client = FakeAthenaClient(states=["FAILED"], state_change_reason="SYNTAX_ERROR: unexpected token")
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate("SELECT bad syntax")

    assert result == "SYNTAX_ERROR: unexpected token"


def test_should_return_error_without_aws_call_when_sql_is_empty():
    client = FakeAthenaClient()
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate("   ")

    assert result is not None
    assert client.start_calls == []


def test_should_return_error_without_aws_call_when_sql_has_embedded_semicolon():
    client = FakeAthenaClient()
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate("SELECT 1; DROP TABLE x")

    assert result is not None
    assert client.start_calls == []


def test_should_return_error_without_aws_call_when_sql_is_non_select():
    client = FakeAthenaClient()
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate("DROP TABLE x")

    assert result is not None
    assert "DROP" in result
    assert client.start_calls == []


def test_should_never_call_get_query_results_during_validate():
    client = FakeAthenaClient(states=["SUCCEEDED"])
    sampler = AthenaSampler(athena_client=client)

    sampler.validate("SELECT 1")

    assert client.get_query_results_calls == []


def test_should_return_fallback_message_when_failed_with_no_reason():
    client = FakeAthenaClient(states=["FAILED"], state_change_reason=None)
    sampler = AthenaSampler(athena_client=client)

    result = sampler.validate("SELECT 1")

    assert result is not None
    assert "failed" in result.lower()
