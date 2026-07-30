from __future__ import annotations

from aws_reference_agent.okf_types import SOURCE_CONTAINER_TYPE, SOURCE_TABLE_TYPE
from aws_reference_agent.sources.glue import GlueSource


class StubPaginator:
    def __init__(self, pages):
        self._pages = pages

    def paginate(self, **kwargs):
        return iter(self._pages)


class StubGlueClient:
    def __init__(self, table_pages=None, database=None, tables=None, partitions=None,
                 partitions_error=None):
        self._table_pages = table_pages or [{"TableList": []}]
        self._database = database or {}
        self._tables = tables or {}
        self._partitions = partitions if partitions is not None else {"Partitions": []}
        self._partitions_error = partitions_error
        self.get_partitions_calls = []

    def get_paginator(self, op_name):
        assert op_name == "get_tables"
        return StubPaginator(self._table_pages)

    def get_database(self, Name):
        return {"Database": self._database}

    def get_table(self, DatabaseName, Name):
        return {"Table": self._tables[Name]}

    def get_partitions(self, DatabaseName, TableName, MaxResults=10):
        self.get_partitions_calls.append((DatabaseName, TableName, MaxResults))
        if self._partitions_error:
            raise self._partitions_error
        return self._partitions


class StubStsClient:
    def __init__(self, account="111122223333", error=None):
        self._account = account
        self._error = error

    def get_caller_identity(self):
        if self._error:
            raise self._error
        return {"Account": self._account}


def make_source(glue_client, region="us-east-1", sts_client=None, sampling_enabled=False, **kwargs):
    return GlueSource(
        database="mydb",
        region=region,
        glue_client=glue_client,
        sts_client=sts_client or StubStsClient(),
        sampling_enabled=sampling_enabled,
        **kwargs,
    )


def test_should_list_database_and_tables_when_listing_concepts():
    glue_client = StubGlueClient(
        table_pages=[
            {"TableList": [{"Name": "b_table", "TableType": "EXTERNAL_TABLE"}]},
            {"TableList": [{"Name": "a_table", "TableType": "VIRTUAL_VIEW"}]},
        ]
    )
    src = make_source(glue_client)
    concepts = src.list_concepts()

    assert concepts[0].id == ("databases", "mydb")
    assert concepts[0].type == SOURCE_CONTAINER_TYPE
    assert concepts[0].resource == "arn:aws:glue:us-east-1:111122223333:database/mydb"
    assert concepts[0].hint == {"database": "mydb"}

    table_refs = concepts[1:]
    assert [r.id for r in table_refs] == [
        ("tables", "a_table"),
        ("tables", "b_table"),
    ]
    assert table_refs[0].type == SOURCE_TABLE_TYPE
    assert table_refs[0].resource == "arn:aws:glue:us-east-1:111122223333:table/mydb/a_table"
    assert table_refs[0].hint == {
        "database": "mydb",
        "table": "a_table",
        "table_type": "VIRTUAL_VIEW",
    }


def test_should_paginate_across_multiple_pages_when_listing_tables():
    glue_client = StubGlueClient(
        table_pages=[
            {"TableList": [{"Name": "t1", "TableType": "EXTERNAL_TABLE"}]},
            {"TableList": [{"Name": "t2", "TableType": "EXTERNAL_TABLE"}]},
            {"TableList": [{"Name": "t3", "TableType": "EXTERNAL_TABLE"}]},
        ]
    )
    src = make_source(glue_client)
    concepts = src.list_concepts()
    tables = [r for r in concepts if r.type == SOURCE_TABLE_TYPE]
    assert [r.id[1] for r in tables] == ["t1", "t2", "t3"]


def test_should_cache_list_concepts_when_called_twice():
    glue_client = StubGlueClient(
        table_pages=[{"TableList": [{"Name": "t1", "TableType": "EXTERNAL_TABLE"}]}]
    )
    src = make_source(glue_client)
    src.list_concepts()
    src.list_concepts()
    # get_paginator itself has no call counter on the stub; verify via a mutable spy
    calls = []
    real_get_paginator = glue_client.get_paginator

    def spy(op_name):
        calls.append(op_name)
        return real_get_paginator(op_name)

    glue_client.get_paginator = spy
    src.list_concepts()
    assert calls == []


def test_should_fall_back_to_placeholder_account_when_sts_fails():
    glue_client = StubGlueClient(table_pages=[{"TableList": []}])
    src = make_source(glue_client, sts_client=StubStsClient(error=RuntimeError("boom")))
    concepts = src.list_concepts()
    assert "arn:aws:glue:us-east-1:" in concepts[0].resource
    assert concepts[0].resource.endswith(":database/mydb")


def test_should_read_database_fields_when_reading_database_concept():
    glue_client = StubGlueClient(
        database={
            "Name": "mydb",
            "Description": "my database",
            "LocationUri": "s3://bucket/mydb",
            "Parameters": {"owner": "team-x"},
            "CreateTime": None,
        }
    )
    src = make_source(glue_client)
    ref = src.find(("databases", "mydb"))
    result = src.read_concept(ref)
    assert result == {
        "database": "mydb",
        "description": "my database",
        "location_uri": "s3://bucket/mydb",
        "parameters": {"owner": "team-x"},
        "created": None,
    }


def test_should_read_table_fields_when_reading_external_table_concept():
    import datetime

    glue_client = StubGlueClient(
        table_pages=[{"TableList": [{"Name": "events", "TableType": "EXTERNAL_TABLE"}]}],
        tables={
            "events": {
                "DatabaseName": "mydb",
                "Name": "events",
                "TableType": "EXTERNAL_TABLE",
                "Description": "event log",
                "CreateTime": datetime.datetime(2024, 1, 1),
                "UpdateTime": datetime.datetime(2024, 2, 1),
                "StorageDescriptor": {
                    "Columns": [
                        {"Name": "id", "Type": "bigint", "Comment": "pk"},
                        {"Name": "payload", "Type": "struct<a:int,b:string>"},
                    ],
                    "Location": "s3://bucket/events/",
                    "InputFormat": "org.apache.hadoop.mapred.TextInputFormat",
                    "OutputFormat": "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
                    "SerdeInfo": {
                        "SerializationLibrary": "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe",
                        "Parameters": {"field.delim": ","},
                    },
                },
                "PartitionKeys": [{"Name": "dt", "Type": "string"}],
                "Parameters": {
                    "classification": "csv",
                    "compressionType": "gzip",
                    "recordCount": "1000",
                    "sizeKey": "2048",
                    "custom": "value",
                },
            }
        },
        partitions={"Partitions": [{"Values": ["2024-01-01"]}, {"Values": ["2024-01-02"]}]},
    )
    src = make_source(glue_client)
    ref = src.find(("tables", "events"))
    result = src.read_concept(ref)

    assert result["database"] == "mydb"
    assert result["table"] == "events"
    assert result["table_type"] == "EXTERNAL_TABLE"
    assert result["description"] == "event log"
    assert result["columns"][0] == {"name": "id", "type": "bigint", "description": "pk"}
    assert result["columns"][1]["type"] == "struct"
    assert result["partition_keys"] == [{"name": "dt", "type": "string"}]
    assert result["location"] == "s3://bucket/events/"
    assert result["input_format"] == "org.apache.hadoop.mapred.TextInputFormat"
    assert result["output_format"] == "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"
    assert result["serde"] == "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe"
    assert result["serde_parameters"] == {"field.delim": ","}
    assert result["parameters"]["custom"] == "value"
    assert result["classification"] == "csv"
    assert result["compressionType"] == "gzip"
    assert result["recordCount"] == "1000"
    assert result["sizeKey"] == "2048"
    assert result["created"] == "2024-01-01T00:00:00"
    assert result["updated"] == "2024-02-01T00:00:00"
    assert "view_original_text" not in result
    assert result["sample_partition_values"] == [["2024-01-01"], ["2024-01-02"]]


def test_should_include_view_original_text_when_table_type_is_virtual_view():
    glue_client = StubGlueClient(
        table_pages=[{"TableList": [{"Name": "v1", "TableType": "VIRTUAL_VIEW"}]}],
        tables={
            "v1": {
                "DatabaseName": "mydb",
                "Name": "v1",
                "TableType": "VIRTUAL_VIEW",
                "ViewOriginalText": "SELECT * FROM events",
                "StorageDescriptor": {"Columns": []},
            }
        },
    )
    src = make_source(glue_client)
    ref = src.find(("tables", "v1"))
    result = src.read_concept(ref)
    assert result["view_original_text"] == "SELECT * FROM events"


def test_should_omit_sample_partition_values_when_table_has_no_partition_keys():
    glue_client = StubGlueClient(
        table_pages=[{"TableList": [{"Name": "t1", "TableType": "EXTERNAL_TABLE"}]}],
        tables={
            "t1": {
                "DatabaseName": "mydb",
                "Name": "t1",
                "TableType": "EXTERNAL_TABLE",
                "StorageDescriptor": {"Columns": []},
            }
        },
    )
    src = make_source(glue_client)
    ref = src.find(("tables", "t1"))
    result = src.read_concept(ref)
    assert "sample_partition_values" not in result
    assert glue_client.get_partitions_calls == []


def test_should_swallow_get_partitions_failure_when_fetching_sample_values():
    glue_client = StubGlueClient(
        table_pages=[{"TableList": [{"Name": "t1", "TableType": "EXTERNAL_TABLE"}]}],
        tables={
            "t1": {
                "DatabaseName": "mydb",
                "Name": "t1",
                "TableType": "EXTERNAL_TABLE",
                "StorageDescriptor": {"Columns": []},
                "PartitionKeys": [{"Name": "dt", "Type": "string"}],
            }
        },
        partitions_error=RuntimeError("boom"),
    )
    src = make_source(glue_client)
    ref = src.find(("tables", "t1"))
    result = src.read_concept(ref)
    assert "sample_partition_values" not in result


def test_should_raise_when_reading_concept_with_unknown_type():
    from aws_reference_agent.sources.base import ConceptRef

    glue_client = StubGlueClient()
    src = make_source(glue_client)
    ref = ConceptRef(id=("foo", "bar"), type="Something Else")
    try:
        src.read_concept(ref)
        assert False, "expected ValueError"
    except ValueError as e:
        assert "Unknown concept type" in str(e)


def test_should_return_none_when_sampling_disabled():
    glue_client = StubGlueClient(
        table_pages=[{"TableList": [{"Name": "t1", "TableType": "EXTERNAL_TABLE"}]}]
    )
    src = make_source(glue_client, sampling_enabled=False)
    ref = src.find(("tables", "t1"))
    assert src.sample_rows(ref) is None


def test_should_return_none_when_sampling_a_database_ref():
    glue_client = StubGlueClient(table_pages=[{"TableList": []}])
    src = make_source(glue_client)
    ref = src.find(("databases", "mydb"))
    assert src.sample_rows(ref) is None


class StubAthenaClientNoOutputLocation:
    """Athena client stub that reports no OutputLocation on the workgroup."""

    def get_work_group(self, WorkGroup):
        return {"WorkGroup": {"Configuration": {"ResultConfiguration": {}}}}


class StubAthenaClientWithOutputLocation:
    """Athena client stub that reports an OutputLocation on the workgroup."""

    def get_work_group(self, WorkGroup):
        return {
            "WorkGroup": {
                "Configuration": {
                    "ResultConfiguration": {"OutputLocation": "s3://bucket/output/"}
                }
            }
        }


def test_should_raise_when_sampling_enabled_and_no_output_location_available():
    import pytest
    from aws_reference_agent.sources.athena import AthenaSampler

    with pytest.raises(ValueError, match="output location"):
        AthenaSampler(
            workgroup="primary",
            output_location=None,
            athena_client=StubAthenaClientNoOutputLocation(),
        )


def test_should_not_raise_when_output_location_is_explicitly_provided():
    from aws_reference_agent.sources.athena import AthenaSampler

    # Should succeed without calling get_work_group
    sampler = AthenaSampler(
        workgroup="primary",
        output_location="s3://bucket/output/",
        athena_client=StubAthenaClientNoOutputLocation(),
    )
    assert sampler.output_location == "s3://bucket/output/"


def test_should_not_raise_when_workgroup_has_output_location_configured():
    from aws_reference_agent.sources.athena import AthenaSampler

    sampler = AthenaSampler(
        workgroup="primary",
        output_location=None,
        athena_client=StubAthenaClientWithOutputLocation(),
    )
    assert sampler.output_location is None
