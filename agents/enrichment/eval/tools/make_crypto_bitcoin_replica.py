#!/usr/bin/env python3
"""Create a SCHEMA-ONLY replica of the public bigquery-public-data.crypto_bitcoin
dataset in the eval project, with all column/table descriptions STRIPPED.

Why a stripped replica (not a copy):
  - The public `transactions` table is ~hundreds of GB; copying data would be
    absurdly expensive and is unnecessary -- table-mode enrichment reads the
    schema (+ INFORMATION_SCHEMA), not the rows.
  - The public schema ships rich column descriptions. Leaving them in would hand
    BOTH agents free grounding from the schema itself, defeating the point of the
    eval (measure enrichment from the shared grounding corpus). So we strip every
    `description` -> a "bare schema" replica.

The public `inputs`/`outputs` are VIEWs (flattened from transactions.inputs[]/
outputs[]). We materialize their *output schema* as empty TABLEs so they are
reliably enumerated by the agent like any other table (no view dependency on the
nested `transactions`).

Idempotent: existing tables are left untouched. Mirrors the style of
eval/runner.py ensure_dataset_copy.

Usage:
  python3 eval/tools/make_crypto_bitcoin_replica.py \
      --project <your-project> [--dataset crypto_bitcoin] \
      [--location US] [--dry-run]
"""

import argparse
import json
import subprocess
import sys
import tempfile

SOURCE = "bigquery-public-data:crypto_bitcoin"
TABLES = ["blocks", "transactions", "inputs", "outputs"]


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


def _table_schema(table, project):
  """Return the stripped schema (list of field dicts) for SOURCE.table."""
  show = _bq(["show", "--schema", "--format=json", f"{SOURCE}.{table}"], project)
  return _strip_descriptions(json.loads(show.stdout))


def main(argv=None):
  ap = argparse.ArgumentParser()
  ap.add_argument("--project", required=True,
                  help="your GCP project to create the replica in")
  ap.add_argument("--dataset", default="crypto_bitcoin")
  ap.add_argument("--location", default="US")
  ap.add_argument("--dry-run", action="store_true")
  args = ap.parse_args(argv)
  proj, ds = args.project, args.dataset

  # Ensure the dataset exists.
  if _bq(["show", "--dataset", f"{proj}:{ds}"], proj, check=False).returncode != 0:
    print(f"[setup] creating dataset {proj}:{ds} ({args.location})")
    if not args.dry_run:
      _bq(["mk", "--dataset", f"--location={args.location}", f"{proj}:{ds}"], proj)
  else:
    print(f"[setup] dataset {proj}:{ds} already exists")

  for t in TABLES:
    target = f"{proj}:{ds}.{t}"
    if _bq(["show", target], proj, check=False).returncode == 0:
      print(f"[setup] table {target} already exists -- skipping")
      continue
    schema = _table_schema(t, proj)
    n = len(schema)
    print(f"[setup] creating empty table {target} "
          f"({n} top-level fields, descriptions stripped)")
    if args.dry_run:
      continue
    # `bq mk --table <ref> <schema_file>` creates an empty table. A JSON schema
    # MUST be passed as a file -- an inline positional arg is parsed as the legacy
    # `name:TYPE,...` format and rejects JSON.
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
      json.dump(schema, fh)
      schema_path = fh.name
    _bq(["mk", "--table", target, schema_path], proj)

  print("[setup] done.")
  return 0


if __name__ == "__main__":
  sys.exit(main())
