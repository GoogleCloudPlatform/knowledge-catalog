"""kcmd-based catalog access for the unified agents.

The enrichment agents talk to the Knowledge Catalog ONLY through the vendored
`kcmd` CLI (Metadata-as-Code), never the Dataplex API directly:

  * table_mode -> `kcmd init --bigquery-dataset <proj>.<dataset>` + a manifest
    declaring the schema aspect + `kcmd pull`, then reads schema from the pulled
    `catalog/` entries.
  * doc_mode   -> `kcmd init --entry-group <proj>.<loc>.<eg>` to scaffold the
    entry-group manifest (scope + snapshot + publishing); the agent then
    generates
    the entries. We use a normal entry group (STANDARD layout: `<id>.yaml` +
    `<id>.overview.md`) rather than `--kb` (DOCUMENTS layout) so the agent's
    generated entry files are consumed directly without reformatting.

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
  npm run build`), then `kcmd` on PATH (e.g. an `npm install -g`ed kcmd).
  """
  env_bin = os.environ.get("KCMD_BIN")
  if env_bin and os.path.exists(env_bin):
    return env_bin
  # tools/ -> src -> enrichment_agent -> <repo root>
  vendored = os.path.abspath(
      os.path.join(os.path.dirname(__file__), "../../../mdcode/dist/kcmd")
  )
  if os.path.exists(vendored):
    return vendored
  return shutil.which("kcmd") or vendored


KCMD_BIN = _resolve_kcmd()

# Manifest for a bq-dataset scope. The snapshot declares ALL of the entry's
# aspects so `kcmd pull` fetches everything about each table (schema columns,
# table properties, storage, and any existing overview + queries) — init's
# default snapshot does NOT include these. We publish the `overview` and
# `queries` aspects back to the dataset's live @bigquery entries. No `reference:` section: table mode pulls
# its entries directly and never reads `.ref.*` mirrors (that flow belongs to
# context_overlay mode via _OVERLAY_MANIFEST + init_reference).
#
# The `queries` aspect requires the `dataplex.entryGroups.useQueriesAspect`
# permission per the Dataplex `queries` aspect type's authorization
# declaration. If the
# caller lacks this perm, kcmd push will fail with a 403 on the queries
# aspect specifically — overview will still go through. The per-table
# `<table>.queries.md` sidecars produced by bq_usage_tools are kcmd-standard
# layout aspect sidecars (YAML frontmatter merged into the aspect payload),
# so no further wiring is needed beyond this manifest change.
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
    "    - dataplex-types.global.queries\n"
    "publishing:\n"
    "  aspects:\n"
    "    - dataplex-types.global.overview\n"
    "    - dataplex-types.global.queries\n"
)


def _build_bq_manifest(
    project: str, dataset: str, with_glossary_links: bool = False
) -> str:
  """Build the BigQuery-dataset manifest, optionally wiring glossary-linking

  config into snapshot/publishing/reference. When `with_glossary_links` is
  True, snapshot+reference declare `entryLinks: [definition, synonym]` (so
  `kcmd pull`/`reference` fetch existing column links) and publishing
  declares `entryLinks: [definition]` (so `kcmd push` reconciles agent-added
  links to Dataplex).
  """
  if not with_glossary_links:
    return _BQ_MANIFEST.format(project=project, dataset=dataset)
  return (
      f"scope: bq-dataset.{project}.{dataset}\n"
      "snapshot:\n"
      "  entries:\n"
      "    - dataplex-types.global.bigquery-table\n"
      "  aspects:\n"
      "    - dataplex-types.global.schema\n"
      "    - dataplex-types.global.bigquery-table\n"
      "    - dataplex-types.global.storage\n"
      "    - dataplex-types.global.overview\n"
      "    - dataplex-types.global.queries\n"
      "  entryLinks:\n"
      "    - definition\n"
      "    - synonym\n"
      "publishing:\n"
      "  aspects:\n"
      "    - dataplex-types.global.overview\n"
      "    - dataplex-types.global.queries\n"
      "  entryLinks:\n"
      "    - definition\n"
      "reference:\n"
      f"  scope: bq-dataset.{project}.{dataset}\n"
      "  snapshot:\n"
      "    entries:\n"
      "      - dataplex-types.global.bigquery-table\n"
      "    aspects:\n"
      "      - dataplex-types.global.schema\n"
      "      - dataplex-types.global.overview\n"
      "    entryLinks:\n"
      "      - definition\n"
      "      - synonym\n"
  )


# Manifest for the doc-mode entry group. `kcmd init --entry-group` writes only a
# bare `scope:` line (no snapshot/publishing), which makes `kcmd push` load no
# entry types and silently no-op; so — mirroring init_pull_dataset for bq-dataset
# — we always write this complete manifest after init. The entry-group source
# token is `entryGroup` (source.ts) and uses the STANDARD layout. `entry_type` is
# the full `project.location.entryTypeId` (the 1P `dataplex-types.global.generic`
# type for doc-mode KB entries); kcmd requires entry types to be 3-part, and
# publishing entries must be a subset of snapshot entries.
_EG_MANIFEST = (
    "scope: entryGroup.{project}.{location}.{eg}\n"
    "snapshot:\n"
    "  entries:\n"
    "    - {entry_type}\n"
    "  aspects:\n"
    "    - dataplex-types.global.generic\n"
    "    - dataplex-types.global.overview\n"
    "publishing:\n"
    "  entries:\n"
    "    - {entry_type}\n"
    "  aspects:\n"
    "    - dataplex-types.global.generic\n"
    "    - dataplex-types.global.overview\n"
)

# Manifest for the context-overlay mode. The `scope:` is the editable
# entry group where the NEW overlay entries are created/pushed (generic entry
# type + overview aspect). The `reference:` section pulls the read-only 1P
# BigQuery table entries (with schema + any existing overview) into `reference/`
# via `kcmd reference` — these ground the overlays but are never pushed.
_OVERLAY_MANIFEST = (
    "scope: entryGroup.{project}.{location}.{eg}\n"
    "snapshot:\n"
    "  entries:\n"
    "    - {entry_type}\n"
    "  aspects:\n"
    "    - dataplex-types.global.generic\n"
    "    - dataplex-types.global.overview\n"
    "    - dataplex-types.global.queries\n"
    "publishing:\n"
    "  entries:\n"
    "    - {entry_type}\n"
    "  aspects:\n"
    "    - dataplex-types.global.generic\n"
    "    - dataplex-types.global.overview\n"
    "    - dataplex-types.global.queries\n"
    "reference:\n"
    "  scope: bq-dataset.{ref_project}.{ref_dataset}\n"
    "  snapshot:\n"
    "    entries:\n"
    "      - dataplex-types.global.bigquery-table\n"
    "    aspects:\n"
    "      - dataplex-types.global.schema\n"
    "      - dataplex-types.global.overview\n"
)


def _build_eg_manifest(
    project: str,
    location: str,
    eg: str,
    entry_type: str,
    with_glossary_links: bool = False,
) -> str:
  """KB/EntryGroup manifest with optional `entryLinks: [definition]` wired

  into snapshot and publishing (so `kcmd pull` brings down existing
  entry→term links and `kcmd push` reconciles agent-added ones).

  Uses `definition` (directed: SOURCE=entry, TARGET=glossary term) rather
  than `related` so the link round-trips through kcmd's existing push
  reconciliation (which keys on SOURCE/TARGET ref types). Semantically
  `related` would be a tighter fit, but `related` is undirected and the
  reconciler needs additional work to dedup undirected links.
  """
  if not with_glossary_links:
    return _EG_MANIFEST.format(
        project=project, location=location, eg=eg, entry_type=entry_type
    )
  return (
      f"scope: entryGroup.{project}.{location}.{eg}\n"
      "snapshot:\n"
      "  entries:\n"
      f"    - {entry_type}\n"
      "  aspects:\n"
      "    - dataplex-types.global.generic\n"
      "    - dataplex-types.global.overview\n"
      "  entryLinks:\n"
      "    - definition\n"
      "publishing:\n"
      "  entries:\n"
      f"    - {entry_type}\n"
      "  aspects:\n"
      "    - dataplex-types.global.generic\n"
      "    - dataplex-types.global.overview\n"
      "  entryLinks:\n"
      "    - definition\n"
  )


def _build_overlay_manifest(
    project: str,
    location: str,
    eg: str,
    ref_project: str,
    ref_dataset: str,
    entry_type: str,
    with_glossary_links: bool = False,
) -> str:
  """Context-overlay manifest with optional `entryLinks: [definition]` in

  snapshot+publishing — links are anchored on the overlay entry (in the
  user's EG), TARGET is a glossary term. SOURCE never points at the BQ
  reference entry, so Dataplex's `@bigquery`-EG-only constraint for
  BQ-anchored links doesn't apply, and the link resource lives in the
  user's overlay EG → full version control via `kcmd pull`/`push`.

  Uses `definition` (directed) to match table mode's reconciliation
  semantics; see `_build_eg_manifest` rationale.
  """
  if not with_glossary_links:
    return _OVERLAY_MANIFEST.format(
        project=project,
        location=location,
        eg=eg,
        ref_project=ref_project,
        ref_dataset=ref_dataset,
        entry_type=entry_type,
    )
  return (
      f"scope: entryGroup.{project}.{location}.{eg}\n"
      "snapshot:\n"
      "  entries:\n"
      f"    - {entry_type}\n"
      "  aspects:\n"
      "    - dataplex-types.global.generic\n"
      "    - dataplex-types.global.overview\n"
      "    - dataplex-types.global.queries\n"
      "  entryLinks:\n"
      "    - definition\n"
      "publishing:\n"
      "  entries:\n"
      f"    - {entry_type}\n"
      "  aspects:\n"
      "    - dataplex-types.global.generic\n"
      "    - dataplex-types.global.overview\n"
      "    - dataplex-types.global.queries\n"
      "  entryLinks:\n"
      "    - definition\n"
      "reference:\n"
      f"  scope: bq-dataset.{ref_project}.{ref_dataset}\n"
      "  snapshot:\n"
      "    entries:\n"
      "      - dataplex-types.global.bigquery-table\n"
      "    aspects:\n"
      "      - dataplex-types.global.schema\n"
      "      - dataplex-types.global.overview\n"
  )


def _run(
    args: list[str], cwd: str, project: str | None = None, timeout: int = 300
) -> tuple[bool, str]:
  if not os.path.exists(KCMD_BIN):
    return False, (
        f"kcmd not found. Build it: `cd toolbox/mdcode && npm install "
        f"&& npm run build`, or set $KCMD_BIN / npm install -g kcmd."
    )
  env = os.environ.copy()
  if project:
    env.setdefault("CLOUDSDK_CORE_PROJECT", project)
  # Echo the real command we shell out to (transparency: these are genuine kcmd
  # subprocess calls, not status messages).
  print(f"[kcmd] $ kcmd {' '.join(args)}", flush=True)
  try:
    pr = subprocess.run(
        [KCMD_BIN, *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return pr.returncode == 0, (pr.stdout + pr.stderr).strip()[-600:]
  except Exception as e:  # noqa: BLE001
    return False, str(e)


# --------------------------------------------------------------------------- #
# table_mode: bq-dataset discovery via init + pull
# --------------------------------------------------------------------------- #
def init_pull_dataset(
    output_dir: str,
    project: str,
    dataset: str,
    with_glossary_links: bool = False,
) -> tuple[bool, str]:
  """`kcmd init --bigquery-dataset` (scope) -> write the schema-declaring

  manifest -> `kcmd pull` (entries + schema). No Dataplex API.

  When `with_glossary_links=True`, the manifest also declares entryLinks
  config so `pull` brings down existing column-level links and `push` can
  publish agent-added links. Callers also need to invoke
  `pull_glossary_as_reference(...)` to bring glossary terms into the
  workspace for the LinkingAgent's `terms_context`.
  """
  os.makedirs(output_dir, exist_ok=True)
  ok_init, msg_init = _run(
      ["init", "--bigquery-dataset", f"{project}.{dataset}"],
      output_dir,
      project,
      120,
  )
  with open(os.path.join(output_dir, "catalog.yaml"), "w") as f:
    f.write(_build_bq_manifest(project, dataset, with_glossary_links))
  ok_pull, msg_pull = _run(["pull"], output_dir, project, 300)
  return (ok_pull, (msg_init + "\n" + msg_pull).strip()[-600:])


def pull_glossary_as_reference(
    output_dir: str,
    project: str,
    glossary_scope: str,
) -> tuple[bool, str]:
  """Side-channel pull of glossary terms into the workspace as a one-off

  reference fetch. Temporarily swaps `catalog.yaml` to point the reference
  scope at the glossary while preserving the caller's existing main `scope:`
  line, runs `kcmd reference` (writes `catalog/glossaries/.../*.ref.yaml`),
  then restores the original `catalog.yaml` so subsequent
  `kcmd pull`/`push`/`reference` runs see the caller's manifest unchanged.

  Auto-detects the main scope from the existing catalog.yaml — works for any
  source type (bq-dataset, entryGroup, kb, glossary, ...). The caller must
  have already written a valid catalog.yaml (typically via `init_pull_*` or
  `init_reference`).
  """
  manifest_path = os.path.join(output_dir, "catalog.yaml")
  with open(manifest_path) as f:
    original = f.read()
  # Preserve whatever `scope:` line the caller's manifest already declares;
  # kcmd just needs SOME parseable main scope to load the manifest, and we
  # don't trigger any main-scope pull/push between the swap and restore.
  main_scope_line = next(
      (line for line in original.splitlines() if line.startswith("scope:")),
      None,
  )
  if main_scope_line is None:
    return False, "catalog.yaml has no 'scope:' line"
  try:
    with open(manifest_path, "w") as f:
      f.write(f"{main_scope_line}\nreference:\n  scope: {glossary_scope}\n")
    return _run(["reference"], output_dir, project, 300)
  finally:
    with open(manifest_path, "w") as f:
      f.write(original)


def build_glossary_scope(glossaries: list[str]) -> tuple[str | None, str]:
  """Convert a list of `project.location.glossaryId` strings to the kcmd

  glossary scope string `glossary.<project>.<location>.<id1,id2,...>`.

  Returns (scope, warning_msg). When glossaries span multiple
  project/location pairs, the first one is used and a warning is returned
  (kcmd glossary source today takes a single project.location prefix).
  Returns (None, error_msg) when the input is empty or malformed.
  """
  groups: dict[str, list[str]] = {}
  for g in glossaries:
    parts = g.split(".")
    if len(parts) < 3:
      continue
    pl = ".".join(parts[:2])
    gid = parts[2]
    groups.setdefault(pl, []).append(gid)

  if not groups:
    return (
        None,
        "Invalid glossary formats. Expected project.location.glossaryId.",
    )

  pl = next(iter(groups))
  gids = ",".join(groups[pl])
  warning = ""
  if len(groups) > 1:
    warning = (
        f"Multiple project/locations for glossaries found. Only using {pl}"
        " due to kcmd limits."
    )
  return f"glossary.{pl}.{gids}", warning


def list_glossaries(output_dir: str) -> list[dict]:
  """Read all Glossary and Term YAMLs under `<output_dir>/catalog/glossaries/`.

  Returns:
    [{id, type, display_name, description, parent}, ...]
  """
  glossary_dir = os.path.join(output_dir, "catalog", "glossaries")
  if not os.path.isdir(glossary_dir):
    return []
  entries = []
  for yaml_path in sorted(
      glob.glob(os.path.join(glossary_dir, "**", "*.yaml"), recursive=True)
  ):
    if os.path.basename(yaml_path) == "catalog.yaml":
      continue
    try:
      with open(yaml_path) as f:
        entry = yaml.safe_load(f) or {}
    except Exception:  # noqa: BLE001
      continue

    resource = entry.get("resource", {}) or {}
    # Strip .ref or .yaml from the end
    basename = os.path.basename(yaml_path)
    if basename.endswith(".ref.yaml"):
      eid = basename[:-9]
    else:
      eid = basename[:-5]

    eid = entry.get("name") or eid
    fqn = resource.get("name", "")

    # If FQN is missing, try to synthesize it from the path
    if not fqn:
      # Path pattern: .../glossaries/Glossary (ID)/[Category (ID)/]terms/Term (ID).yaml
      # Or simpler for kcmd layout
      parts = yaml_path.split(os.sep)
      try:
        # Find the 'glossaries' segment
        g_idx = parts.index("glossaries")

        # Extract IDs from "DisplayName (ID)" format if present
        def extract_id(s):
          import re

          m = re.search(r"\(([^)]+)\)$", s)
          return m.group(1) if m else s

        # This is a bit complex due to kcmd layout variety,
        # but let's try a best-effort based on typical kcmd layout
        # For now, let's trust kcmd pull to have the resource.name
        # or at least the top-level name being usable if we prepend projects/
        pass
      except ValueError:
        pass

    entries.append({
        "id": eid,
        "fqn": fqn,
        "type": entry.get("type"),
        "display_name": resource.get("displayName", ""),
        "description": resource.get("description", ""),
        "parent": resource.get("parent", ""),
    })
  return entries


def _dataset_dir(output_dir: str, project: str, dataset: str) -> str:
  return os.path.join(output_dir, "catalog", "bigquery", project, dataset)


def list_tables(output_dir: str, project: str, dataset: str) -> list[str]:
  d = _dataset_dir(output_dir, project, dataset)
  return [
      os.path.basename(y)[:-5]
      for y in sorted(glob.glob(os.path.join(d, "*.yaml")))
      if os.path.basename(y) != "catalog.yaml" and not y.endswith(".ref.yaml")
  ]


def _aspect(entry: dict, suffix: str) -> dict:
  """Aspect by last name segment -- accepts short alias keys ("schema") and full

  `dataplex-types.global.schema` keys, nested under `aspects:` or top level.
  """
  for container in ((entry or {}).get("aspects", {}) or {}, entry or {}):
    for k, v in (container or {}).items():
      if isinstance(k, str) and k.split(".")[-1] == suffix:
        return v or {}
  return {}


def _read_table_meta_path(
    path: str, project: str, dataset: str, table: str
) -> dict:
  """Read a table entry YAML at `path` into the meta dict the agents use.

  Shared by `read_table_meta` (pulled `catalog/`) and
  `read_reference_table_meta`
  (read-only `reference/`).
  """
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
      "entry_type_3part": entry.get(
          "type", "dataplex-types.global.bigquery-table"
      ),
      "display_name": res.get("displayName", table),
      "description": res.get("description", ""),
      "schema_fields": schema_fields,
      "source_entry_id": res.get("name", ""),
      "existing_overview": _aspect(entry, "overview").get("content", ""),
      "resource_name": (entry.get("resource", {}) or {}).get("name", ""),
  }


def read_table_meta(
    output_dir: str, project: str, dataset: str, table: str
) -> dict:
  """Read one pulled table entry into the meta dict the table agent uses."""
  path = os.path.join(
      _dataset_dir(output_dir, project, dataset), f"{table}.yaml"
  )
  return _read_table_meta_path(path, project, dataset, table)


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
    lines.append(
        f"  - {f.get('name','')}: {f.get('dataType','')}"
        f"{mode} (metadataType={f.get('metadataType','')}){desc}"
    )
  if len(fields) > max_fields:
    lines.append(f"  ... ({len(fields) - max_fields} more columns omitted)")
  return "\n".join(lines)


# --------------------------------------------------------------------------- #
# doc_mode: entry-group manifest scaffold via init --entry-group
# --------------------------------------------------------------------------- #
def init_entry_group(
    output_dir: str,
    entry_group: str,
    entry_type: str = "dataplex-types.global.generic",
    with_glossary_links: bool = False,
) -> tuple[bool, str]:
  """Scaffold the catalog.yaml with `kcmd init --entry-group <proj>.<loc>.<eg>`.

  Always writes the complete manifest afterward (init can't reach the catalog
  for a brand-new entry group, and its bare `scope:` output lacks
  snapshot/publishing). `entry_group` is `project.location.eg`; `entry_type` is
  the full `project.location.entryTypeId` for the entries.

  When `with_glossary_links=True`, the manifest also declares
  `entryLinks: [definition]` so `kcmd pull` brings down existing entry→term
  links and `kcmd push` reconciles agent-added ones. Callers should also
  invoke `pull_glossary_as_reference(...)` to bring glossary terms into the
  workspace for the EntityLinkingAgent's `terms_context`.
  """
  os.makedirs(output_dir, exist_ok=True)
  parts = entry_group.split(".")
  project = parts[0] if parts else ""
  # Run init --entry-group for validation/auth, but always overwrite catalog.yaml
  # with the complete manifest below — init's bare `scope:` output lacks the
  # snapshot/publishing config that `kcmd push` needs to load entry types and
  # publish the overview aspect (without it push silently no-ops).
  ok, msg = _run(
      ["init", "--entry-group", entry_group], output_dir, project, 120
  )
  if not ok:
    return False, msg

  manifest_path = os.path.join(output_dir, "catalog.yaml")
  if len(parts) == 3:
    with open(manifest_path, "w") as f:
      f.write(
          _build_eg_manifest(
              project=parts[0],
              location=parts[1],
              eg=parts[2],
              entry_type=entry_type,
              with_glossary_links=with_glossary_links,
          )
      )
    return True, msg or "wrote entry-group manifest"
  return False, msg


def init_pull_entry_group(
    output_dir: str,
    entry_group: str,
    entry_type: str = "dataplex-types.global.generic",
    with_glossary_links: bool = False,
) -> tuple[bool, str]:
  """init_entry_group + `kcmd pull`.

  Pulls any pre-existing entries in this entry group so the agent can treat them
  as seeds (must-preserve) and use their existing overview content as additional
  grounding for the per-entry writer.

  Returns (ok, message).
  """
  ok, msg = init_entry_group(
      output_dir, entry_group, entry_type, with_glossary_links
  )
  if not ok:
    return False, msg
  parts = entry_group.split(".")
  project = parts[0] if parts else ""
  ok_pull, msg_pull = _run(["pull"], output_dir, project, 300)

  combined_msg = (msg + "\n" + msg_pull).strip()[-600:]

  # If it failed but the reason is simply that the group doesn't exist yet,
  # that's OK for an initial setup. We treat it as success and move on.
  if not ok_pull and (
      "NOT_FOUND" in combined_msg or "does not exist" in combined_msg
  ):
    return (
        True,
        (
            "(Note: Entry Group not found on cloud; proceeding with empty local"
            " state)"
        ),
    )

  return ok_pull, combined_msg


def list_kb_entries(output_dir: str) -> list[dict]:
  """Read all KB entry YAMLs (+ adjacent `.overview.md` sidecars) under
  `<output_dir>/catalog/` into structured dicts.

  Used by doc_mode AFTER `init_pull_entry_group` to discover what entries
  already exist in the KC entry group. Returns:
    [{id, display_name, description, existing_overview}, ...]

  The STANDARD layout puts entry YAMLs at `catalog/<id>.yaml` and any
  overview sidecar at `catalog/<id>.overview.md`. We also fall back to reading
  the overview aspect's `content` field on the YAML in case the layout doesn't
  use sidecars.
  """
  catalog_dir = os.path.join(output_dir, "catalog")
  if not os.path.isdir(catalog_dir):
    return []
  entries = []
  # Use recursive glob to find nested entries (namespace/project/location/id)
  for yaml_path in sorted(
      glob.glob(os.path.join(catalog_dir, "**", "*.yaml"), recursive=True)
  ):
    if os.path.basename(yaml_path) == "catalog.yaml" or yaml_path.endswith(
        ".ref.yaml"
    ):
      continue
    try:

      with open(yaml_path) as f:
        entry = yaml.safe_load(f) or {}
    except Exception:  # noqa: BLE001
      continue
    sidecar = yaml_path[: -len(".yaml")] + ".overview.md"
    overview = ""
    if os.path.exists(sidecar):
      try:
        with open(sidecar) as f:
          overview = f.read()
      except OSError:
        pass
    if not overview:
      overview = _aspect(entry, "overview").get("content", "") or ""
    resource = entry.get("resource", {}) or {}
    raw_name = (
        entry.get("name")
        or entry.get("id")
        or os.path.basename(yaml_path)[: -len(".yaml")]
    )
    # Pulled entry-group entries carry their FULL nested local name
    # (`<namespace>/<project>/<location>/<entryId>`, where `<entryId>` may itself
    # contain slashes, e.g. `a/m`). Strip ONLY the 3-segment
    # namespace/project/location prefix and keep the remainder as the id, so
    # path-qualified ids (`a/m`, `a/index`) round-trip cleanly through
    # pull -> enumerate -> push instead of collapsing to the last segment.
    parts = raw_name.split("/")
    eid = "/".join(parts[3:]) if len(parts) > 3 else parts[-1]
    entries.append({
        "id": eid,
        "display_name": resource.get(
            "displayName", entry.get("displayName", eid)
        ),
        "description": resource.get("description", ""),
        "existing_overview": overview,
        "yaml_path": yaml_path,
    })
  return entries


# --------------------------------------------------------------------------- #
# context_overlay_mode: read-only 1P table pull via `kcmd reference`
# --------------------------------------------------------------------------- #
def init_reference(
    output_dir: str,
    entry_group: str,
    ref_project: str,
    ref_dataset: str,
    entry_type: str = "dataplex-types.global.generic",
    with_glossary_links: bool = False,
) -> tuple[bool, str]:
  """Write the overlay manifest (editable `scope:` EG + `reference:` bq-dataset)

  and run `kcmd reference` to pull the read-only 1P table entries into
  `catalog/bigquery/<proj>/<dataset>/<table>.ref.yaml`. No Dataplex API
  directly.

  `entry_group` is `project.location.eg` (where overlays will be pushed);
  `ref_project.ref_dataset` is the BigQuery dataset whose tables are
  referenced. When `with_glossary_links=True`, the manifest declares
  `entryLinks: [definition]` so overlay→term links round-trip via `kcmd
  pull`/`push`; callers should also invoke `pull_glossary_as_reference(...)`
  to bring glossary terms into the workspace.
  """
  os.makedirs(output_dir, exist_ok=True)
  parts = entry_group.split(".")
  if len(parts) != 3:
    return False, (
        "entry_group must be `project.location.entryGroupId` (got"
        f" '{entry_group}')."
    )
  project, location, eg = parts
  with open(os.path.join(output_dir, "catalog.yaml"), "w") as f:
    f.write(
        _build_overlay_manifest(
            project=project,
            location=location,
            eg=eg,
            ref_project=ref_project,
            ref_dataset=ref_dataset,
            entry_type=entry_type,
            with_glossary_links=with_glossary_links,
        )
    )
  return _run(["reference"], output_dir, ref_project, 300)


def init_reference_and_pull(
    output_dir: str,
    entry_group: str,
    ref_project: str,
    ref_dataset: str,
    entry_type: str = "dataplex-types.global.generic",
    with_glossary_links: bool = False,
) -> tuple[bool, str]:
  """Scaffold for HYBRID mode (doc KB entries + table context-overlays in one EG).

  Writes the OVERLAY manifest (a superset of the entry-group manifest: same EG
  `scope:` publishing generic+overview, plus the `queries` aspect and a
  `reference:` bq-dataset section), then runs BOTH:
    * `kcmd reference` — pulls the read-only 1P table entries
      (`catalog/bigquery/<proj>/<ds>/<table>.ref.yaml`) that ground the overlays;
    * `kcmd pull`      — pulls any pre-existing entry-group entries so doc-mode
      can seed/preserve them (exactly like `init_pull_entry_group`).

  So one scaffold supports both entry kinds: doc KB entries (generic+overview)
  and table overlays (generic+overview+queries), with the BQ tables referenced.
  Returns (ok, message). A NOT_FOUND on pull (empty/new EG) is treated as OK.
  """
  ok, msg = init_reference(
      output_dir, entry_group, ref_project, ref_dataset, entry_type,
      with_glossary_links,
  )
  if not ok:
    return False, msg
  eg_project = entry_group.split(".")[0]
  ok_pull, msg_pull = _run(["pull"], output_dir, eg_project, 300)
  combined = (msg + "\n" + msg_pull).strip()[-600:]
  if not ok_pull and ("NOT_FOUND" in combined or "does not exist" in combined):
    return True, "(reference OK; entry group not found on cloud — empty local state)"
  return ok_pull, combined


def _reference_dir(output_dir: str, project: str, dataset: str) -> str:
  # `kcmd reference` writes the read-only 1P entries straight into the main
  # catalog tree as `catalog/bigquery/<project>/<dataset>/<table>.ref.yaml`
  # (StandardLayout name `bigquery/<project>/<dataset>/<table>.ref`); there is no
  # separate `reference/` folder.
  return os.path.join(output_dir, "catalog", "bigquery", project, dataset)


def list_reference_tables(
    output_dir: str, project: str, dataset: str
) -> list[str]:
  d = _reference_dir(output_dir, project, dataset)
  return [
      os.path.basename(y)[: -len(".ref.yaml")]
      for y in sorted(glob.glob(os.path.join(d, "*.ref.yaml")))
  ]


def read_reference_table_meta(
    output_dir: str, project: str, dataset: str, table: str
) -> dict:
  """Read one read-only reference table entry (`<table>.ref.yaml`) into a meta

  dict.

  The 1P overview is pulled to a `.ref.overview.md` sidecar (not the YAML), so
  fill `existing_overview` from there to ground the overlay writer with the
  table's real overview when one exists.
  """
  path = os.path.join(
      _reference_dir(output_dir, project, dataset), f"{table}.ref.yaml"
  )
  meta = _read_table_meta_path(path, project, dataset, table)
  if not (meta.get("existing_overview") or "").strip():
    meta["existing_overview"] = read_reference_overview(
        output_dir, project, dataset, table
    )
  return meta


def read_reference_overview(
    output_dir: str, project: str, dataset: str, table: str
) -> str:
  """Read the 1P table's REAL overview from the `kcmd reference` sidecar.

  `kcmd reference` (StandardLayout) writes a pulled overview aspect to the
  sidecar `catalog/bigquery/<project>/<dataset>/<table>.ref.overview.md` (and
  strips it from the YAML), so this is the only place the genuine 1P overview
  lives. Returns the Markdown body (frontmatter stripped) or "" when the table
  has no overview in the catalog — callers must NOT fabricate one in that case.
  """
  path = os.path.join(
      _reference_dir(output_dir, project, dataset), f"{table}.ref.overview.md"
  )
  if not os.path.exists(path):
    return ""
  try:
    with open(path) as f:
      text = f.read()
  except OSError:
    return ""
  # Strip a leading `---\n...\n---` YAML frontmatter block if present.
  if text.startswith("---\n"):
    end = text.find("\n---", 4)
    if end != -1:
      text = text[end + len("\n---") :].lstrip("\n")
  return text.strip()
