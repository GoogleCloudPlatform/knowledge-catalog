"""AWS Glue Data Catalog source: databases and tables as OKF concepts."""

from __future__ import annotations

from typing import Any

from aws_reference_agent.okf_types import SOURCE_CONTAINER_TYPE, SOURCE_TABLE_TYPE
from aws_reference_agent.sources.base import ConceptRef, Source
from aws_reference_agent.sources.hive_types import column_to_field

_PLACEHOLDER_ACCOUNT = "unknown-account"


class GlueSource(Source):
    name = "glue"

    def __init__(
        self,
        database: str,
        region: str | None = None,
        profile: str | None = None,
        athena_workgroup: str = "primary",
        athena_output_location: str | None = None,
        sampling_enabled: bool = True,
        glue_client=None,
        sts_client=None,
    ) -> None:
        self.database = database
        self.profile = profile
        self.athena_workgroup = athena_workgroup
        self.athena_output_location = athena_output_location
        self.sampling_enabled = sampling_enabled

        if glue_client is None:
            import boto3

            session = boto3.Session(profile_name=profile, region_name=region)
            glue_client = session.client("glue")
            region = region or session.region_name
            if sts_client is None:
                sts_client = session.client("sts")

        self._glue = glue_client
        self._sts = sts_client
        self.region = region
        self._account_id: str | None = None
        self._tables_cache: list[dict[str, Any]] | None = None

        self._sampler = None
        if sampling_enabled:
            try:
                from aws_reference_agent.sources.athena import AthenaSampler

                self._sampler = AthenaSampler(
                    workgroup=athena_workgroup,
                    output_location=athena_output_location,
                    region=region,
                    profile=profile,
                )
            except ImportError:
                self._sampler = None

    def _account(self) -> str:
        if self._account_id is None:
            try:
                identity = self._sts.get_caller_identity() if self._sts else {}
                self._account_id = identity.get("Account", _PLACEHOLDER_ACCOUNT)
            except Exception:
                self._account_id = _PLACEHOLDER_ACCOUNT
        return self._account_id

    def _list_tables(self) -> list[dict[str, Any]]:
        if self._tables_cache is None:
            tables: list[dict[str, Any]] = []
            paginator = self._glue.get_paginator("get_tables")
            for page in paginator.paginate(DatabaseName=self.database):
                tables.extend(page.get("TableList", []))
            tables.sort(key=lambda t: t["Name"])
            self._tables_cache = tables
        return self._tables_cache

    def list_concepts(self) -> list[ConceptRef]:
        account = self._account()
        db = self.database
        concepts = [
            ConceptRef(
                id=("databases", db),
                type=SOURCE_CONTAINER_TYPE,
                resource=f"arn:aws:glue:{self.region}:{account}:database/{db}",
                hint={"database": db},
            )
        ]
        for table in self._list_tables():
            name = table["Name"]
            concepts.append(
                ConceptRef(
                    id=("tables", name),
                    type=SOURCE_TABLE_TYPE,
                    resource=f"arn:aws:glue:{self.region}:{account}:table/{db}/{name}",
                    hint={
                        "database": db,
                        "table": name,
                        "table_type": table.get("TableType"),
                    },
                )
            )
        return concepts

    def read_concept(self, ref: ConceptRef) -> dict[str, Any]:
        if ref.type == SOURCE_CONTAINER_TYPE:
            return self._read_database(ref.hint["database"])
        if ref.type == SOURCE_TABLE_TYPE:
            return self._read_table(ref.hint["database"], ref.hint["table"])
        raise ValueError(f"Unknown concept type: {ref.type}")

    def _read_database(self, database: str) -> dict[str, Any]:
        db = self._glue.get_database(Name=database)["Database"]
        return {
            "database": db.get("Name", database),
            "description": db.get("Description"),
            "location_uri": db.get("LocationUri"),
            "parameters": db.get("Parameters", {}),
            "created": _isoformat(db.get("CreateTime")),
        }

    def _read_table(self, database: str, table_name: str) -> dict[str, Any]:
        table = self._glue.get_table(DatabaseName=database, Name=table_name)["Table"]
        storage = table.get("StorageDescriptor") or {}
        serde_info = storage.get("SerdeInfo") or {}
        parameters = table.get("Parameters") or {}
        partition_keys = table.get("PartitionKeys") or []

        result: dict[str, Any] = {
            "database": table.get("DatabaseName", database),
            "table": table.get("Name", table_name),
            "table_type": table.get("TableType"),
            "description": table.get("Description"),
            "columns": [column_to_field(c) for c in storage.get("Columns", [])],
            "partition_keys": [column_to_field(c) for c in partition_keys],
            "location": storage.get("Location"),
            "input_format": storage.get("InputFormat"),
            "output_format": storage.get("OutputFormat"),
            "serde": serde_info.get("SerializationLibrary"),
            "serde_parameters": serde_info.get("Parameters", {}),
            "parameters": parameters,
            "created": _isoformat(table.get("CreateTime")),
            "updated": _isoformat(table.get("UpdateTime")),
        }

        for key in ("classification", "compressionType", "recordCount", "sizeKey"):
            if key in parameters:
                result[key] = parameters[key]

        if table.get("TableType") == "VIRTUAL_VIEW":
            result["view_original_text"] = table.get("ViewOriginalText")

        if partition_keys:
            values = self._sample_partition_values(database, table_name)
            if values is not None:
                result["sample_partition_values"] = values

        return result

    def _sample_partition_values(
        self, database: str, table_name: str
    ) -> list[list[str]] | None:
        try:
            response = self._glue.get_partitions(
                DatabaseName=database, TableName=table_name, MaxResults=10
            )
        except Exception:
            return None
        return [p.get("Values", []) for p in response.get("Partitions", [])]

    def sample_rows(self, ref: ConceptRef, n: int = 5) -> list[dict[str, Any]] | None:
        if not self.sampling_enabled or ref.type != SOURCE_TABLE_TYPE:
            return None
        if self._sampler is None:
            return None
        return self._sampler.sample(ref.hint["database"], ref.hint["table"], n)

    def validate_query(self, sql: str) -> str | None:
        if self._sampler is None:
            return "Query validation is not available (Athena sampler is disabled or unavailable)."
        return self._sampler.validate(sql)


def _isoformat(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return None
