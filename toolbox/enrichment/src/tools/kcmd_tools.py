"""kcmd-based catalog access for the unified agents.

The enrichment agents talk to the Knowledge Catalog ONLY through the vendored
`kcmd` CLI (Metadata-as-Code), never the Dataplex API directly:

  * table_mode -> `kcmd init --bigquery-dataset <proj>.<dataset>` + a manifest
    declaring the schema aspect + `kcmd pull`, then reads schema from the pulled
    `catalog/` entries.
  * doc_mode   -> `kcmd init --kb <proj>.<loc>.<eg>` to scaffold the Knowledge
    Base manifest (scope + publishing); the agent then generates the entries.

`kcmd push` is intentionally NOT run here — publishing is the user's action.
"""

import glob
import os
import shutil
import subprocess

import yaml


def _resolve_kcmd() -> str:
  """Locate the kcmd binary: $KCMD_BIN, then the vendored
  toolbox/mdcode/dist/kcmd (built via `cd toolbox/mdcode && npm install &&
  npm run build`), then `kcmd` on PATH (e.g. an `npm install -g`ed kcmd)."""
  env_bin = os.environ.get("KCMD_BIN")
  if env_bin and os.path.exists(env_bin):
    return env_bin
  # tools/ -> src -> enrichment_agent -> <repo root>
  vendored = os.path.abspath(os.path.join(
      os.path.dirname(__file__), "../../../mdcode/dist/kcmd"))
  if os.path.exists(vendored):
    return vendored
  return shutil.which("kcmd") or vendored


KCMD_BIN = _resolve_kcmd()

# Manifest for a bq-dataset scope. The snapshot declares ALL of the entry's
# aspects so `kcmd pull` fetches everything about each table (schema columns,
# table properties, storage, and any existing overview) — init's default
# snapshot does NOT include these. We publish ONLY the overview aspect back to
# the dataset's live @bigquery entries.
_BQ_MANIFEST = (
    "scope: bq-dataset.{project}.{dataset}\n"
    "snapshot:\n"
    "  entries:\n"
    "    - dataplex-types.global.bigquery-table\n"
    "  aspects:\n"
    "    - dataplex-types.global.schema\n"
    "    - dataplex-types.global.bigquery-table\n"
    "    - dataplex-types.global.storage\n"
    "    - dataplex-types.global.overview\n"
    "publishing:\n"
    "  aspects:\n"
    "    - dataplex-types.global.overview\n"
)

# Manifest for a Knowledge Base entry group (doc mode), used as a fallback if
# `kcmd init --kb` can't reach the catalog (e.g. a brand-new entry group).
_KB_MANIFEST = (
    "scope: entryGroup.{project}.{location}.{eg}\n"
    "snapshot:\n"
    "  entries:\n"
    "    - {project}.{location}.simple-entry-type\n"
    "  aspects:\n"
    "    - dataplex-types.global.overview\n"
    "publishing:\n"
    "  entries:\n"
    "    - {project}.{location}.simple-entry-type\n"
    "  aspects:\n"
    "    - dataplex-types.global.overview\n"
)


def _run(args: list[str], cwd: str, project: str | None = None,
         timeout: int = 300) -> tuple[bool, str]:
  if not os.path.exists(KCMD_BIN):
    return False, (f"kcmd not found. Build it: `cd toolbox/mdcode && npm install "
                   f"&& npm run build`, or set $KCMD_BIN / npm install -g kcmd.")
  env = os.environ.copy()
  if project:
    env.setdefault("CLOUDSDK_CORE_PROJECT", project)
  # Echo the real command we shell out to (transparency: these are genuine kcmd
  # subprocess calls, not status messages).
  print(f"[kcmd] $ kcmd {' '.join(args)}", flush=True)
  try:
    pr = subprocess.run([KCMD_BIN, *args], cwd=cwd, env=env,
                        capture_output=True, text=True, timeout=timeout)
    return pr.returncode == 0, (pr.stdout + pr.stderr).strip()[-600:]
  except Exception as e:  # noqa: BLE001
    return False, str(e)


# --------------------------------------------------------------------------- #
# table_mode: bq-dataset discovery via init + pull
# --------------------------------------------------------------------------- #
def init_pull_dataset(output_dir: str, project: str, dataset: str) -> tuple[bool, str]:
  """`kcmd init --bigquery-dataset` (scope) -> write the schema-declaring
  manifest -> `kcmd pull` (entries + schema). No Dataplex API."""
  os.makedirs(output_dir, exist_ok=True)
  ok_init, msg_init = _run(
      ["init", "--bigquery-dataset", f"{project}.{dataset}"], output_dir, project, 120)
  with open(os.path.join(output_dir, "catalog.yaml"), "w") as f:
    f.write(_BQ_MANIFEST.format(project=project, dataset=dataset))
  ok_pull, msg_pull = _run(["pull"], output_dir, project, 300)
  return ok_pull, (msg_init + "\n" + msg_pull).strip()[-600:]


def _dataset_dir(output_dir: str, project: str, dataset: str) -> str:
  return os.path.join(output_dir, "catalog", f"{project}.{dataset}")


def list_tables(output_dir: str, project: str, dataset: str) -> list[str]:
  d = _dataset_dir(output_dir, project, dataset)
  return [os.path.basename(y)[:-5]
          for y in sorted(glob.glob(os.path.join(d, "*.yaml")))
          if os.path.basename(y) != "catalog.yaml"]


def _aspect(entry: dict, suffix: str) -> dict:
  """Aspect by last name segment -- accepts short alias keys ("schema") and full
  `dataplex-types.global.schema` keys, nested under `aspects:` or top level."""
  for container in ((entry or {}).get("aspects", {}) or {}, entry or {}):
    for k, v in (container or {}).items():
      if isinstance(k, str) and k.split(".")[-1] == suffix:
        return v or {}
  return {}


def read_table_meta(output_dir: str, project: str, dataset: str, table: str) -> dict:
  """Read one pulled table entry into the meta dict the table agent uses."""
  path = os.path.join(_dataset_dir(output_dir, project, dataset), f"{table}.yaml")
  entry = {}
  if os.path.exists(path):
    try:
      with open(path) as f:
        entry = yaml.safe_load(f) or {}
    except Exception:  # noqa: BLE001
      entry = {}
  res = entry.get("resource", {}) or {}
  schema_fields = []
  for f in _aspect(entry, "schema").get("fields", []) or []:
    if isinstance(f, dict):
      schema_fields.append({
          "name": f.get("name", ""),
          "dataType": f.get("dataType", f.get("type", "")),
          "metadataType": f.get("metadataType", ""),
          "mode": f.get("mode", ""),
          "description": f.get("description", ""),
      })
  return {
      "name": entry.get("name", f"{project}.{dataset}/{table}"),
      "table": table,
      "entry_id": entry.get("name", f"{project}.{dataset}/{table}"),
      "entry_type_3part": entry.get("type", "dataplex-types.global.bigquery-table"),
      "display_name": res.get("displayName", table),
      "description": res.get("description", ""),
      "schema_fields": schema_fields,
      "existing_overview": _aspect(entry, "overview").get("content", ""),
  }


def flatten_table_for_prompt(meta: dict, max_fields: int = 300) -> str:
  """Render a meta dict into a compact, LLM-friendly block."""
  lines = [
      f"TABLE: {meta.get('table', '')}",
      f"Entry id: {meta.get('entry_id', '')}",
      f"Entry type: {meta.get('entry_type_3part', '')}",
  ]
  if meta.get("display_name"):
    lines.append(f"Display name: {meta['display_name']}")
  if meta.get("description"):
    lines.append(f"Existing description: {meta['description']}")
  if meta.get("existing_overview"):
    lines.append(f"Existing overview:\n{meta['existing_overview']}")
  fields = meta.get("schema_fields", [])
  lines.append(f"\nSCHEMA ({len(fields)} columns):")
  for f in fields[:max_fields]:
    desc = f" — {f['description']}" if f.get("description") else ""
    mode = f" [{f['mode']}]" if f.get("mode") else ""
    lines.append(f"  - {f.get('name','')}: {f.get('dataType','')}"
                 f"{mode} (metadataType={f.get('metadataType','')}){desc}")
  if len(fields) > max_fields:
    lines.append(f"  ... ({len(fields) - max_fields} more columns omitted)")
  return "\n".join(lines)


# --------------------------------------------------------------------------- #
# doc_mode: Knowledge Base manifest scaffold via init --kb
# --------------------------------------------------------------------------- #
def init_kb(output_dir: str, entry_group: str) -> tuple[bool, str]:
  """Scaffold the KB catalog.yaml with `kcmd init --kb <proj>.<loc>.<eg>`.
  Falls back to a deterministic KB manifest if init can't reach the catalog
  (e.g. a brand-new entry group). `entry_group` is `project.location.eg`."""
  os.makedirs(output_dir, exist_ok=True)
  parts = entry_group.split(".")
  project = parts[0] if parts else ""
  ok, msg = _run(["init", "--kb", entry_group], output_dir, project, 120)
  manifest_path = os.path.join(output_dir, "catalog.yaml")
  if ok and os.path.exists(manifest_path):
    return True, msg
  # Fallback: write a deterministic KB manifest (project.location.eg).
  if len(parts) == 3:
    with open(manifest_path, "w") as f:
      f.write(_KB_MANIFEST.format(project=parts[0], location=parts[1], eg=parts[2]))
    return True, f"(init --kb unavailable; wrote deterministic KB manifest) {msg}"
  return False, msg
