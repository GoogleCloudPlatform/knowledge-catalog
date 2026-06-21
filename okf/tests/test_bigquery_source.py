from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


def _table_ref(table_id: str) -> SimpleNamespace:
    return SimpleNamespace(table_id=table_id)


def _schema_field(
    name: str, type_: str, mode: str = "NULLABLE", description: str | None = None,
    fields=()
):
    return SimpleNamespace(
        name=name,
        field_type=type_,
        mode=mode,
        description=description,
        fields=tuple(fields),
    )


def _build_mock_client(table_ids, table_objects_by_id):
    client = MagicMock()
    client.list_tables.return_value = [_table_ref(t) for t in table_ids]

    def get_table(table_ref):
        return table_objects_by_id[table_ref.table_id]

    client.get_table.side_effect = get_table
    return client


@patch("reference_agent.sources.bigquery.bigquery.Client")
def test_wildcard_sharded_tables_collapse_to_one_concept(client_cls):
    table_ids = [
        "events_20210101",
        "events_20210102",
        "events_20210103",
        "users",
    ]
    table_objects = {
        tid: SimpleNamespace(
            friendly_name=None,
            description="GA4 events sample." if tid.startswith("events_") else "Users dim.",
            labels={},
            num_rows=10,
            num_bytes=1024,
            created=datetime(2026, 5, 1, tzinfo=timezone.utc),
            modified=datetime(2026, 5, 1, tzinfo=timezone.utc),
            schema=[_schema_field("event_date", "STRING")],
            time_partitioning=None,
            range_partitioning=None,
            clustering_fields=None,
        )
        for tid in table_ids
    }
    client_cls.return_value = _build_mock_client(table_ids, table_objects)

    from reference_agent.sources.bigquery import BigQuerySource

    src = BigQuerySource(dataset="proj.dset")
    concepts = src.list_concepts()
    ids = [c.id for c in concepts]

    assert ("datasets", "dset") in ids
    assert ("tables", "events_") in ids
    assert ("tables", "users") in ids
    assert not any(c.id == ("tables", "events_20210101") for c in concepts)

    family = next(c for c in concepts if c.id == ("tables", "events_"))
    assert family.type == "BigQuery Table"
    assert family.hint["wildcard"] is True
    assert family.hint["shard_count"] == 3
    assert family.hint["last_shard"] == "events_20210103"


@patch("reference_agent.sources.bigquery.bigquery.Client")
def test_sample_rows_uses_list_rows_for_table(client_cls):
    table_objects = {
        "users": SimpleNamespace(table_type="TABLE"),
    }
    client = _build_mock_client(["users"], table_objects)
    client.list_rows.return_value = [
        SimpleNamespace(items=lambda: [("id", 1), ("name", "alice")]),
    ]
    client_cls.return_value = client

    from reference_agent.sources.bigquery import BigQuerySource

    src = BigQuerySource(dataset="proj.dset")
    ref = next(c for c in src.list_concepts() if c.id == ("tables", "users"))
    rows = src.sample_rows(ref, n=3)

    assert rows == [{"id": 1, "name": "alice"}]
    client.list_rows.assert_called_once()
    client.query.assert_not_called()


@patch("reference_agent.sources.bigquery.bigquery.Client")
def test_sample_rows_falls_back_to_query_for_view(client_cls):
    table_objects = {
        "user_summary": SimpleNamespace(table_type="VIEW"),
    }
    client = _build_mock_client(["user_summary"], table_objects)
    query_job = MagicMock()
    query_job.result.return_value = [
        SimpleNamespace(items=lambda: [("user_id", 42), ("orders", 7)]),
    ]
    client.query.return_value = query_job
    client_cls.return_value = client

    from reference_agent.sources.bigquery import BigQuerySource

    src = BigQuerySource(dataset="proj.dset")
    ref = next(c for c in src.list_concepts() if c.id == ("tables", "user_summary"))
    rows = src.sample_rows(ref, n=4)

    assert rows == [{"user_id": 42, "orders": 7}]
    client.list_rows.assert_not_called()
    client.query.assert_called_once()
    sql = client.query.call_args.args[0]
    assert "`proj.dset.user_summary`" in sql
    assert "LIMIT 4" in sql


@patch("reference_agent.sources.bigquery.bigquery.Client")
def test_read_concept_returns_schema_and_partitioning(client_cls):
    table_ids = ["events_20210103"]
    inner = [
        _schema_field("key", "STRING"),
        _schema_field("value", "RECORD", fields=[_schema_field("string_value", "STRING")]),
    ]
    schema = [
        _schema_field("event_date", "STRING"),
        _schema_field("event_params", "RECORD", mode="REPEATED", fields=inner),
    ]
    time_part = SimpleNamespace(type_="DAY", field=None, expiration_ms=None)
    table_objects = {
        "events_20210103": SimpleNamespace(
            friendly_name="Events",
            description="GA4 events table.",
            labels={"team": "ga4"},
            num_rows=100,
            num_bytes=2048,
            created=datetime(2026, 5, 1, tzinfo=timezone.utc),
            modified=datetime(2026, 5, 2, tzinfo=timezone.utc),
            schema=schema,
            time_partitioning=time_part,
            range_partitioning=None,
            clustering_fields=["user_pseudo_id"],
        )
    }
    client_cls.return_value = _build_mock_client(table_ids, table_objects)

    from reference_agent.sources.bigquery import BigQuerySource

    src = BigQuerySource(dataset="proj.dset")
    family = next(c for c in src.list_concepts() if c.id == ("tables", "events_"))

    data = src.read_concept(family)
    assert data["description"] == "GA4 events table."
    assert data["labels"] == {"team": "ga4"}
    assert data["schema"][0]["name"] == "event_date"
    nested = data["schema"][1]
    assert nested["name"] == "event_params"
    assert nested["mode"] == "REPEATED"
    assert nested["fields"][0]["name"] == "key"
    assert nested["fields"][1]["fields"][0]["name"] == "string_value"
    assert data["time_partitioning"]["type"] == "DAY"
    assert data["clustering_fields"] == ["user_pseudo_id"]
    assert data["wildcard"] is True
    assert data["family_prefix"] == "events_"
    assert data["last_shard"] == "events_20210103"
