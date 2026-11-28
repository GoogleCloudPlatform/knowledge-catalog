"""Load the benchmark's OSI models into the Spanner SemanticCatalog graph.

  gcloud spanner databases create semantic_catalog \
    --instance=my-instance --ddl-file=schema.sql
  python3 -I load.py --instance my-instance --database semantic_catalog

Uses `gcloud spanner databases execute-sql` for DML so there is no client
library to install. Rows go in as chunked multi-row INSERTs.

THE ONE INTERESTING BIT is how a metric's field references are resolved. The
expression `SUM(invoice.total_amount)` names `invoice`, but `total_amount` is
DECLARED on the abstract `billing_document` that invoice extends. Those are
two different facts and a dependency answer needs both, so each reference
becomes one row carrying both:

  ref_entity_id    where the field is declared  -> the READS edge
  named_entity_id  what the expression wrote    -> the TOUCHES edge
  inherited        whether those differ

That is what makes `total_exposure` resolve correctly. It reads one field,
`credit_account.current_balance`, declared once on an abstract entity, but
names three concrete subtypes -- so READS returns one field and TOUCHES
returns the three tables you actually have to query. Answering off READS
alone would hand back an abstract entity with no table.
"""

import argparse
import os
import re
import subprocess
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODELS = os.path.join(HERE, "..", "models")

# Qualifiers in a metric expression that are SQL, not entity names.
SQL_WORDS = {
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "SUM",
    "COUNT",
    "DISTINCT",
    "NULLIF",
    "MAX",
    "MIN",
    "AVG",
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "NULL",
    "CAST",
    "AS",
    "IF",
    "COALESCE",
}


def lit(v):
  """A GoogleSQL literal. Arrays become [..]; whitespace is collapsed."""
  if v is None:
    return "NULL"
  if isinstance(v, bool):
    return "TRUE" if v else "FALSE"
  if isinstance(v, list):
    return "[" + ", ".join(lit(str(x)) for x in v) + "]" if v else "NULL"
  s = re.sub(r"\s+", " ", str(v)).strip()
  return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def ansi(block):
  for d in (block or {}).get("dialects", []):
    if d.get("dialect") == "ANSI_SQL":
      return d.get("expression")
  return None


def parse(models_dir, corpus):
  rows = {
      k: []
      for k in (
          "model",
          "entity",
          "field",
          "metric",
          "reads",
          "join",
          "extends",
      )
  }
  for fname in sorted(os.listdir(models_dir)):
    if not fname.endswith(".yaml"):
      continue
    stem = fname[:-5]
    m = yaml.safe_load(open(os.path.join(models_dir, fname)))
    doc = m["semantic_model"][0]
    ai = doc.get("ai_context") or {}
    rows["model"].append([
        stem,
        doc.get("name"),
        doc.get("description"),
        ai.get("instructions"),
        m.get("version"),
        corpus,
    ])

    ents = doc.get("entities") or doc.get("datasets") or []
    own = {e["name"]: {f["name"] for f in e.get("fields", [])} for e in ents}
    sup = {e["name"]: e.get("extends") or [] for e in ents}

    def declarer(entity, field, seen=None):
      """The entity that declares `field`, walking `extends` upward."""
      seen = seen or set()
      if entity in seen:
        return None
      seen.add(entity)
      if field in own.get(entity, ()):
        return entity
      for parent in sup.get(entity, []):
        got = declarer(parent, field, seen)
        if got:
          return got
      return None

    for e in ents:
      eai = e.get("ai_context") or {}
      rows["entity"].append([
          stem,
          e["name"],
          e["name"],
          e.get("description"),
          eai.get("instructions"),
          eai.get("synonyms"),
          bool(e.get("abstract")),
          e.get("source"),
      ])
      for parent in e.get("extends") or []:
        rows["extends"].append([stem, e["name"], parent])
      for f in e.get("fields", []):
        fai = f.get("ai_context") or {}
        rows["field"].append([
            stem,
            e["name"],
            f["name"],
            f["name"],
            f.get("description"),
            f.get("label"),
            f.get("datatype"),
            ansi(f.get("expression")),
            bool((f.get("dimension") or {}).get("is_time")),
            fai.get("synonyms"),
        ])

    for met in doc.get("metrics", []):
      mai = met.get("ai_context") or {}
      expr = ansi(met.get("expression")) or ""
      rows["metric"].append([
          stem,
          met["name"],
          met["name"],
          met.get("description"),
          mai.get("instructions"),
          mai.get("synonyms"),
          met.get("datatype"),
          expr,
      ])
      seen = set()
      for named, fld in re.findall(r"\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b", expr):
        if named.upper() in SQL_WORDS or named not in own:
          continue
        decl = declarer(named, fld)
        if not decl or (met["name"], decl, fld, named) in seen:
          continue
        seen.add((met["name"], decl, fld, named))
        rows["reads"].append(
            [stem, met["name"], decl, fld, named, decl != named]
        )

    for r in doc.get("relationships", []):
      rai = r.get("ai_context") or {}
      rows["join"].append([
          stem,
          r["name"],
          r["from"],
          r["to"],
          r["name"],
          rai.get("instructions"),
          r.get("from_columns"),
          r.get("to_columns"),
      ])
  return rows


COLUMNS = {
    "model": (
        "SemanticModel",
        [
            "model_id",
            "name",
            "description",
            "instructions",
            "osi_version",
            "corpus",
        ],
    ),
    "entity": (
        "Entity",
        [
            "model_id",
            "entity_id",
            "name",
            "description",
            "instructions",
            "synonyms",
            "is_abstract",
            "source",
        ],
    ),
    "field": (
        "Field",
        [
            "model_id",
            "entity_id",
            "field_id",
            "name",
            "description",
            "label",
            "datatype",
            "expression",
            "is_time",
            "synonyms",
        ],
    ),
    "metric": (
        "Metric",
        [
            "model_id",
            "metric_id",
            "name",
            "description",
            "instructions",
            "synonyms",
            "datatype",
            "expression",
        ],
    ),
    "reads": (
        "MetricReadsField",
        [
            "model_id",
            "metric_id",
            "ref_entity_id",
            "ref_field_id",
            "named_entity_id",
            "inherited",
        ],
    ),
    "join": (
        "EntityJoin",
        [
            "model_id",
            "relationship_id",
            "from_entity_id",
            "to_entity_id",
            "name",
            "instructions",
            "from_columns",
            "to_columns",
        ],
    ),
    "extends": (
        "EntityExtends",
        ["model_id", "entity_id", "supertype_entity_id"],
    ),
}


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--instance", required=True)
  ap.add_argument("--database", default="semantic_catalog")
  ap.add_argument("--models", default=DEFAULT_MODELS)
  ap.add_argument(
      "--corpus",
      default="benchmark",
      help="tag for this source; reloading a corpus replaces only its rows",
  )
  ap.add_argument("--chunk", type=int, default=80)
  args = ap.parse_args()

  def run(sql):
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
    if out.returncode:
      print("FAILED:", sql[:300], file=sys.stderr)
      print(out.stderr[:1200], file=sys.stderr)
      sys.exit(1)

  rows = parse(args.models, args.corpus)
  # Entities, fields and metrics interleave in SemanticModel ON DELETE
  # CASCADE, so dropping one corpus's models drops everything under them and
  # leaves the other corpora alone.
  run(f"DELETE FROM SemanticModel WHERE corpus = {lit(args.corpus)}")
  for key, (table, cols) in COLUMNS.items():
    data = rows[key]
    for i in range(0, len(data), args.chunk):
      part = data[i : i + args.chunk]
      values = ", ".join("(" + ", ".join(lit(v) for v in r) + ")" for r in part)
      run(f"INSERT INTO {table} ({', '.join(cols)}) VALUES {values}")
    print(f"  {table:<18} {len(data)}")
  print(f"  inherited field refs {sum(1 for r in rows['reads'] if r[5])}")


if __name__ == "__main__":
  sys.exit(main())
