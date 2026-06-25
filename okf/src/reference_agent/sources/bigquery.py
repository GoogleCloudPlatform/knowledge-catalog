from __future__ import annotations

import re
from typing import Any

from google.cloud import bigquery

from reference_agent.sources.base import ConceptRef, Source

_SHARD_SUFFIX_RE = re.compile(r"^(?P<prefix>.+?_)(?P<shard>\d{6,8})$")


def _schema_to_dict(fields: list[bigquery.SchemaField]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for f in fields:
        entry: dict[str, Any] = {
            "name": f.name,
            "type": f.field_type,
            "mode": f.mode,
        }
        if f.description:
            entry["description"] = f.description
        if f.fields:
            entry["fields"] = _schema_to_dict(list(f.fields))
        out.append(entry)
    return out


class BigQuerySource(Source):
    name = "bigquery"

    def __init__(self, dataset: str, billing_project: str | None = None):
        if "." not in dataset:
            raise ValueError(
                "dataset must be in 'project.dataset' form, "
                f"got {dataset!r}"
            )
        self.dataset_project, self.dataset_id = dataset.split(".", 1)
        self.client = bigquery.Client(project=billing_project)
        self._dataset_ref = bigquery.DatasetReference(
            self.dataset_project, self.dataset_id
        )
        self._concepts_cache: list[ConceptRef] | None = None
        self._family_index: dict[tuple[str, ...], list[str]] = {}

    def _dataset_resource_uri(self) -> str:
        return (
            f"https://bigquery.googleapis.com/v2/projects/"
            f"{self.dataset_project}/datasets/{self.dataset_id}"
        )

    def _table_resource_uri(self, table_id: str) -> str:
        return (
            f"https://bigquery.googleapis.com/v2/projects/"
            f"{self.dataset_project}/datasets/{self.dataset_id}/tables/{table_id}"
        )

    def list_concepts(self) -> list[ConceptRef]:
        if self._concepts_cache is not None:
            return self._concepts_cache

        concepts: list[ConceptRef] = []
        concepts.append(
            ConceptRef(
                id=("datasets", self.dataset_id),
                type="BigQuery Dataset",
                resource=self._dataset_resource_uri(),
                hint={
                    "dataset_project": self.dataset_project,
                    "dataset_id": self.dataset_id,
                },
            )
        )

        families: dict[str, list[str]] = {}
        singletons: list[str] = []
        for tbl in self.client.list_tables(self._dataset_ref):
            m = _SHARD_SUFFIX_RE.match(tbl.table_id)
            if m:
                families.setdefault(m.group("prefix"), []).append(tbl.table_id)
            else:
                singletons.append(tbl.table_id)

        for prefix, shards in sorted(families.items()):
            family_concept_id = ("tables", prefix)
            shards_sorted = sorted(shards)
            concepts.append(
                ConceptRef(
                    id=family_concept_id,
                    type="BigQuery Table",
                    resource=self._table_resource_uri(f"{prefix}*"),
                    hint={
                        "wildcard": True,
                        "family_prefix": prefix,
                        "shard_count": len(shards),
                        "first_shard": shards_sorted[0],
                        "last_shard": shards_sorted[-1],
                    },
                )
            )
            self._family_index[family_concept_id] = shards_sorted

        for table_id in sorted(singletons):
            concepts.append(
                ConceptRef(
                    id=("tables", table_id),
                    type="BigQuery Table",
                    resource=self._table_resource_uri(table_id),
                    hint={"wildcard": False, "table_id": table_id},
                )
            )

        self._concepts_cache = concepts
        return concepts

    def _representative_table_id(self, ref: ConceptRef) -> str:
        if ref.hint.get("wildcard"):
            return ref.hint["last_shard"]
        return ref.hint["table_id"]

    def read_concept(self, ref: ConceptRef) -> dict[str, Any]:
        if ref.type == "BigQuery Dataset":
            ds = self.client.get_dataset(self._dataset_ref)
            return {
                "dataset_project": self.dataset_project,
                "dataset_id": self.dataset_id,
                "friendly_name": ds.friendly_name,
                "description": ds.description,
                "location": ds.location,
                "labels": dict(ds.labels or {}),
                "created": ds.created.isoformat() if ds.created else None,
                "modified": ds.modified.isoformat() if ds.modified else None,
                "default_partition_expiration_ms": ds.default_partition_expiration_ms,
            }

        if ref.type == "BigQuery Table":
            self.list_concepts()
            table_id = self._representative_table_id(ref)
            tbl = self.client.get_table(self._dataset_ref.table(table_id))
            data: dict[str, Any] = {
                "dataset_project": self.dataset_project,
                "dataset_id": self.dataset_id,
                "representative_table_id": table_id,
                "wildcard": bool(ref.hint.get("wildcard")),
                "friendly_name": tbl.friendly_name,
                "description": tbl.description,
                "labels": dict(tbl.labels or {}),
                "num_rows": tbl.num_rows,
                "num_bytes": tbl.num_bytes,
                "created": tbl.created.isoformat() if tbl.created else None,
                "modified": tbl.modified.isoformat() if tbl.modified else None,
                "schema": _schema_to_dict(list(tbl.schema or [])),
            }
            if ref.hint.get("wildcard"):
                data["family_prefix"] = ref.hint["family_prefix"]
                data["shard_count"] = ref.hint["shard_count"]
                data["first_shard"] = ref.hint["first_shard"]
                data["last_shard"] = ref.hint["last_shard"]
            if tbl.time_partitioning:
                data["time_partitioning"] = {
                    "type": tbl.time_partitioning.type_,
                    "field": tbl.time_partitioning.field,
                    "expiration_ms": tbl.time_partitioning.expiration_ms,
                }
            if tbl.range_partitioning:
                rp = tbl.range_partitioning
                data["range_partitioning"] = {
                    "field": rp.field,
                    "range": {
                        "start": rp.range_.start,
                        "end": rp.range_.end,
                        "interval": rp.range_.interval,
                    },
                }
            if tbl.clustering_fields:
                data["clustering_fields"] = list(tbl.clustering_fields)
            return data

        raise ValueError(f"Unknown concept type: {ref.type}")

    def sample_rows(
        self, ref: ConceptRef, n: int = 5
    ) -> list[dict[str, Any]] | None:
        if ref.type != "BigQuery Table":
            return None
        self.list_concepts()
        table_id = self._representative_table_id(ref)
        table_ref = self._dataset_ref.table(table_id)
        try:
            tbl = self.client.get_table(table_ref)
        except Exception:
            return None
        table_type = (getattr(tbl, "table_type", None) or "TABLE").upper()
        try:
            if table_type == "TABLE":
                row_iter = self.client.list_rows(table_ref, max_results=n)
            else:
                # VIEW / MATERIALIZED_VIEW / EXTERNAL / SNAPSHOT — the
                # tabledata.list REST endpoint refuses non-base-tables, so
                # fall back to a small query that materializes the rows.
                sql = (
                    f"SELECT * FROM `{self.dataset_project}."
                    f"{self.dataset_id}.{table_id}` LIMIT {int(n)}"
                )
                row_iter = self.client.query(sql).result()
            return [dict(r.items()) for r in row_iter]
        except Exception:
            return None
