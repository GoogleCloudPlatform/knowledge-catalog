#!/usr/bin/env python3
"""Create a SCHEMA-ONLY replica of any public BigQuery dataset in the eval
project, with all column/table descriptions STRIPPED.

Generalizes make_crypto_bitcoin_replica.py for the other public-dataset samples
(ga4_merch_store, stackoverflow). Same rationale: the public tables are large
(don't copy data) and ship rich descriptions (strip them so the agent gets no
free grounding from the schema — facts must come from the shared corpus). Empty
tables are created from the source schema.

`--tables` entries are `name` (same id on both sides) or `src=dst` (replicate the
source table `src` under the target id `dst` — used for GA4, whose date-sharded
`events_YYYYMMDD` tables collapse to a single representative `events` table).

Idempotent: existing target tables are left untouched. Mirrors the style of
eval/runner.py ensure_dataset_copy.

Usage:
  python3 eval/tools/make_public_replica.py \
      --source bigquery-public-data.stackoverflow \
      --dataset stackoverflow \
      --tables posts_questions,posts_answers,users,votes,comments,badges,tags \
      --project <your-project> [--location US] [--dry-run]

  python3 eval/tools/make_public_replica.py \
      --source bigquery-public-data.ga4_obfuscated_sample_ecommerce \
      --dataset ga4_obfuscated_sample_ecommerce \
      --tables events_20210131=events --project <your-project>
"""

import argparse
import json
import subprocess
import sys
import tempfile


def _bq(args, project, check=True):
  return subprocess.run(["bq", "--project_id", project, *args],
                        capture_output=True, text=True, check=check)


def _strip_descriptions(fields):
  """Recursively drop `description` (and `policyTags`) from a BQ schema field list
  so the replica carries no human-written semantics -- only names/types/modes."""
  out = []
  for f in fields:
    g = {k: v for k, v in f.items() if k not in ("description", "policyTags")}
    if g.get("fields"):
      g["fields"] = _strip_descriptions(g["fields"])
    out.append(g)
  return out


def _table_schema(source_ref, src_table, project):
  """Return the stripped schema (list of field dicts) for `source.src_table`."""
  src_project, src_dataset = source_ref.split(".", 1)
  show = _bq(["show", "--schema", "--format=json",
              f"{src_project}:{src_dataset}.{src_table}"], project)
  return _strip_descriptions(json.loads(show.stdout))


def _parse_tables(spec):
  """`a,b=c` -> [('a','a'), ('b','c')]  (src, dst)."""
  pairs = []
  for item in spec.split(","):
    item = item.strip()
    if not item:
      continue
    if "=" in item:
      src, dst = item.split("=", 1)
      pairs.append((src.strip(), dst.strip()))
    else:
      pairs.append((item, item))
  return pairs


def main(argv=None):
  ap = argparse.ArgumentParser()
  ap.add_argument("--source", required=True,
                  help="source `project.dataset` (e.g. bigquery-public-data.stackoverflow)")
  ap.add_argument("--dataset", required=True, help="target dataset id")
  ap.add_argument("--tables", required=True,
                  help="comma list of `name` or `src=dst`")
  ap.add_argument("--project", required=True,
                  help="your GCP project to create the replica in")
  ap.add_argument("--location", default="US")
  ap.add_argument("--dry-run", action="store_true")
  args = ap.parse_args(argv)
  proj, ds = args.project, args.dataset
  tables = _parse_tables(args.tables)

  if _bq(["show", "--dataset", f"{proj}:{ds}"], proj, check=False).returncode != 0:
    print(f"[setup] creating dataset {proj}:{ds} ({args.location})")
    if not args.dry_run:
      _bq(["mk", "--dataset", f"--location={args.location}", f"{proj}:{ds}"], proj)
  else:
    print(f"[setup] dataset {proj}:{ds} already exists")

  for src_table, dst_table in tables:
    target = f"{proj}:{ds}.{dst_table}"
    if _bq(["show", target], proj, check=False).returncode == 0:
      print(f"[setup] table {target} already exists -- skipping")
      continue
    schema = _table_schema(args.source, src_table, proj)
    label = src_table if src_table == dst_table else f"{src_table} -> {dst_table}"
    print(f"[setup] creating empty table {target} from {label} "
          f"({len(schema)} top-level fields, descriptions stripped)")
    if args.dry_run:
      continue
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
      json.dump(schema, fh)
      schema_path = fh.name
    _bq(["mk", "--table", target, schema_path], proj)

  print("[setup] done.")
  return 0


if __name__ == "__main__":
  sys.exit(main())
