"""Run every named block in queries.sql against the catalog database.

  python3 -I run_queries.py --instance my-instance

Exists so the queries in that file are verified rather than asserted: if one
stops parsing or a label is renamed in schema.sql, this fails loudly.
"""

import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def blocks(path):
  text = open(path).read()
  parts = re.split(r"^-- name:\s*(\S+)\s*$", text, flags=re.M)
  # parts[0] is the file preamble; then (name, body) pairs.
  for i in range(1, len(parts), 2):
    body = parts[i + 1].strip().rstrip(";").strip()
    if body:
      yield parts[i], body


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--instance", required=True)
  ap.add_argument("--database", default="semantic_catalog")
  ap.add_argument("--queries", default=os.path.join(HERE, "queries.sql"))
  args = ap.parse_args()

  failed = 0
  for name, sql in blocks(args.queries):
    out = subprocess.run(
        [
            "gcloud",
            "spanner",
            "databases",
            "execute-sql",
            args.database,
            "--instance",
            args.instance,
            "--sql",
            sql,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    print(f"\n--- {name} ---")
    if out.returncode:
      failed += 1
      print("FAILED:", out.stderr.strip()[:800])
    else:
      body = out.stdout.strip()
      print(body if body else "(no rows)")
  if failed:
    print(f"\n{failed} query/queries failed")
    return 1
  print("\nall queries ran")
  return 0


if __name__ == "__main__":
  sys.exit(main())
