"""Doc mode: recursive depth-crawl of Google Docs → map-reduce summarize →

LLM-emitted knowledge-base mdcode. Ported from the former doc_agent_runner.
"""

import asyncio
import glob
import os
import re
import uuid

import common
from engine import (
    ENTRY_WRITER_INSTRUCTION,  # legacy ADK path, kept for compat
    EnumerationResult,
    PER_DOC_SUMMARIZER_INSTRUCTION,
    PER_DOC_SUMMARIZER_MODEL,
    TOPIC_REDUCER_INSTRUCTION,
    create_entry_writer_runner,  # legacy fallback, no longer wired in
    create_enumeration_runner,
    create_mdcode_runner,
    create_summarizer_runner,  # v2.5 #4: passed to common.generate_text_direct
)
from google.genai import types
import refine
from tools import feedback_tools
from tools import confluence_tools, github_tools, sharepoint_tools
from tools import kcmd_tools
from tools.drive_tools import (
    extract_folder_id,
    extract_gdoc_id,
    fetch_doc_text,
    get_cache_mode,
    is_local_path,
    list_folder_files,
    list_local_md,
    read_local_md,
    read_summary_cache,
    write_summary_cache,
)
import yaml

MAX_BATCH_SIZE = 10  # Reverted from v2.6's 3 (back to v2.5). v2.6 tried Flash via direct API to allow bigger throughput but Vertex routes Flash to a 32K-capped backend variant regardless of API path for this project, forcing batch=3, which then over-saturated Flash quota on back-to-back runs and bloated the EnumerationAgent's input.
MAX_DEPTH = 2  # Was 3 — depth-3 mostly surfaced tangential links; dropping it cuts crawl + summarize ~30% (v2.5 optimization #1).
CONCURRENCY_LIMIT = 6  # Reverted from v2.6's 12 (back to v2.5). Summarizer is on Pro again; 12 trips Vertex 429s on big-input Pro calls.
# Stage 1 (per-doc summary) runs on PER_DOC_SUMMARIZER_MODEL (Flash) — small
# per-call payloads, well within Flash routing limits, tolerates 20-way
# concurrency without 429s. Stage 1 is the cold-run hot path; cache hits
# bypass it entirely so warm-cache runs ignore this limit.
PER_DOC_CONCURRENCY = 20

# The 1P "generic" entry type that all knowledge-base entries are created as
# (cloud/dataplex/catalog/types/entry-types/generic.textproto -> the global
# Dataplex type). The enriched content lands as the `overview` aspect on these
# entries. This is fixed -- there is no per-run entry-type choice.
_GENERIC_ENTRY_TYPE = "dataplex-types.global.generic"


def _slugify(name: str) -> str:
  """kebab-case id from a component name (e.g.

  'Metadata as Code CLI (kcmd)' -> 'metadata-as-code-cli-kcmd'). Used to give
  code components stable seed ids.
  """
  slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
  return slug or "code-component"


async def _fetch_url(
    url: str, depth: int, mime_type: str = "", modified_time: str | None = None
):
  print(f"[Crawler] 📥 Fetching (Depth {depth}): {url}", flush=True)
  content = await asyncio.to_thread(
      fetch_doc_text, url, mime_type, modified_time=modified_time
  )
  return url, depth, content


async def _summarize_one_doc(
    url: str,
    raw_content: str,
    modified_time: str | None,
    sem: asyncio.Semaphore,
    model: str,
    usage_acc: dict | None,
) -> str:
  """Stage-1 Map (cache-aware): produce a topic-NEUTRAL per-doc summary card.

  On summary-cache HIT (key = `(doc_id, modified_time)`), skip the LLM call
  entirely and return the cached card. On MISS, summarize the raw text via
  the direct-API path (faster than ADK runner) and persist the card.

  The cache layer (drive_tools.read_summary_cache / write_summary_cache) is
  a no-op unless `KC_ENRICH_CACHE_MODE=summary` — in `raw` or `off` mode
  every call falls through to the LLM.
  """
  doc_id = extract_gdoc_id(url)
  cached = read_summary_cache(doc_id, modified_time)
  if cached is not None:
    return cached
  prompt = f"DOCUMENT URL: {url}\n\nDOCUMENT CONTENT:\n{raw_content[:60000]}"
  async with sem:
    summary = await common.generate_text_direct(
        PER_DOC_SUMMARIZER_INSTRUCTION,
        prompt,
        model=model,
        usage_acc=usage_acc,
    )
  write_summary_cache(doc_id, summary, modified_time)
  return summary


async def _reduce_summaries_with_topic(
    topic: str,
    master_scope_text: str,
    batch_summaries: list[tuple[str, int, str]],
    sem: asyncio.Semaphore,
    model: str,
    usage_acc: dict | None,
) -> str:
  """Stage-2 Reduce (uncached): collapse a batch of neutral per-doc cards

  through the user's TOPIC lens.

  Input is much smaller than the legacy batch summarizer (cards are ~5×
  smaller than raw doc text), so each batch call is fast and cheap.
  Output is concatenated by the caller into `compiled_summary` and fed to
  the enumerator — identical wire shape to the legacy pipeline.
  """
  cards_text = "\n\n".join(
      f"--- DOC CARD (Depth {depth}): {url} ---\n{card}"
      for (url, depth, card) in batch_summaries
  )
  prompt = (
      f"TOPIC: {topic}\n\nMASTER SCOPE:\n{master_scope_text}\n\nBATCH"
      f" CARDS:\n{cards_text}"
  )
  async with sem:
    return await common.generate_text_direct(
        TOPIC_REDUCER_INSTRUCTION,
        prompt,
        model=model,
        usage_acc=usage_acc,
    )


async def _summarize_batch(
    topic: str,
    master_scope_text: str,
    batch_docs: list,
    sem: asyncio.Semaphore,
    model: str,
    usage_acc: dict | None = None,
) -> str:
  """Batch summarizer (Pro via ADK runner — v2.5 state, after v2.6 was reverted).

  History (for future readers): v2.6 attempted to swap this to Flash via
  common.generate_text_direct to bypass the LlmAgent path's 32K Flash routing
  cap. That cap held even for direct generate_content calls when the request
  shape included SUMMARIZER_INSTRUCTION as system_instruction (Vertex
  routed Flash to a 32K-capped backend variant regardless of API). The
  workaround (MAX_BATCH_SIZE=3) tripled batch count, bloated the
  EnumerationAgent's input ~3×, and saturated Flash quota on back-to-back
  runs. Net: 12% latency win vs much worse reliability. Reverted.
  """
  async with sem:
    runner = create_summarizer_runner(model)
    user_id = str(uuid.uuid4())
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user_id
    )

    docs_text = ""
    for url, depth, content in batch_docs:
      docs_text += (
          f"\n\n--- DOCUMENT (Depth {depth}): {url} ---\n{content[:50000]}\n"
      )

    prompt = (
        f"TOPIC: {topic}\n\nMASTER SCOPE:\n{master_scope_text}\n\nRAW BATCH"
        f" DOCUMENTS:\n{docs_text}"
    )

    new_summary = ""
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session.id,
        new_message=types.Content(
            role="user", parts=[types.Part.from_text(text=prompt)]
        ),
    ):
      usage = getattr(event, "usage_metadata", None)
      if usage and usage_acc is not None:
        usage_acc["input"] += getattr(usage, "prompt_token_count", 0) or 0
        usage_acc["output"] += getattr(usage, "candidates_token_count", 0) or 0
      if event.content and event.content.parts:
        for part in event.content.parts:
          if part.text:
            new_summary += part.text
    print(f"[Agent] ✅ Batch of {len(batch_docs)} documents summarized.")
    return new_summary


def _build_synthetic_scope(topic: str, folder_files: list[dict]) -> str:
  """Synthesize a Master Scope when seeding purely from a Drive folder.

  A folder has no single authoritative document, so flattening every file into
  depth 0 leaves the summarizer without a coherent scope to map findings onto.
  Instead we fabricate a scope doc that names the topic as the overarching
  project and enumerates the folder's files as its constituent sources.
  """
  lines = [
      f"# Master Scope (synthetic): {topic}",
      "",
      (
          f'Treat "{topic}" as the single overarching project for this'
          " knowledge base. The following source documents were collected from"
          " a Google Drive folder. Group all extracted findings into coherent"
          " sub-topics under this project; do not treat each source file as"
          " its own top-level project."
      ),
      "",
      "## Source documents",
  ]
  for f in folder_files:
    lines.append(f"- {f.get('name', 'Untitled')} ({f.get('mimeType', '')})")
  return "\n".join(lines)


def _partition_doc_inputs(docs: list[str], folders: list[str] | None):
  """Route each --docs/--folder entry to Drive vs local markdown by format.

  Both flags are mixed, comma-separated lists routed per entry (see
  drive_tools.is_local_path, which is format-first so the decision doesn't
  depend on the process CWD except for bare relative names):
    --docs:   a Drive Doc URL/ID -> drive_docs; a local .md file -> depth-0
              spine; a local directory -> depth-1 children.
    --folder: a Drive folder URL/ID -> drive_folders; a local directory (or
              file) -> depth-1 children.

  Args:
    docs: mixed --docs entries (Drive Doc URLs/IDs and/or local .md files/dirs).
    folders: mixed --folder entries (Drive folder URLs/IDs and/or local dirs).

  Returns:
    A 4-tuple (drive_docs, drive_folders, local_spine_md, local_child_md).
  """
  local_spine_md, local_child_md = [], []
  drive_docs, drive_folders = [], []
  for d in (docs or []):
    d = (d or "").strip()
    if not d:
      continue
    if is_local_path(d):
      files = list_local_md(d)
      if os.path.isdir(os.path.expanduser(d)):
        local_child_md.extend(files)
        kind = f"local md folder ({len(files)} file(s))"
      else:
        local_spine_md.extend(files)
        kind = "local md spine file" if files else "local md file (MISSING)"
    else:
      drive_docs.append(d)
      kind = "Drive doc"
    print(f"[Route] --docs {d!r} -> {kind}", flush=True)
  for f in (folders or []):
    f = (f or "").strip()
    if not f:
      continue
    if is_local_path(f):
      files = list_local_md(f)
      local_child_md.extend(files)
      kind = (f"local md folder ({len(files)} file(s))" if files
              else "local md folder (EMPTY/MISSING)")
    else:
      drive_folders.append(f)
      kind = "Drive folder"
    print(f"[Route] --folder {f!r} -> {kind}", flush=True)
  return (drive_docs, drive_folders,
          sorted(set(local_spine_md)), sorted(set(local_child_md)))


def _normalize_entries(output_dir: str) -> list[str]:
  """Normalize every generated KB entry YAML so `kcmd push` accepts it:

  * Ensure a top-level `name:` — the entry-group STANDARD layout indexes
    entries by `name` (standard.ts), but the LLM emits `id:`; without a
    `name` the layout indexes zero entries and `kcmd push` silently no-ops.
  * Ensure the required `generic` aspect — the generic entry type declares
    `required_aspects { aspectTypes/generic }`, so an entry missing it is
    rejected on push. We add `dataplex-types.global.generic` with the
    template's freeform `type`/`system` fields. The enriched prose stays in
    the separate `overview` aspect (the `<id>.overview.md` sidecar).
  """
  catalog_dir = os.path.join(output_dir, "catalog")
  if not os.path.isdir(catalog_dir):
    return []
  fixed = []
  for yaml_path in sorted(glob.glob(os.path.join(catalog_dir, "*.yaml"))):
    if os.path.basename(yaml_path) == "catalog.yaml":
      continue
    try:
      with open(yaml_path) as f:
        entry = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
      continue
    changed = False
    if not entry.get("name"):
      name = entry.get("id") or os.path.basename(yaml_path)[: -len(".yaml")]
      entry = {"name": name, **entry}  # name first; keep other fields
      changed = True
    aspects = entry.get("aspects") or {}
    if not any(
        isinstance(k, str) and k.split(".")[-1] == "generic" for k in aspects
    ):
      aspects["dataplex-types.global.generic"] = {
          "type": "knowledge-base",
          "system": "enrichment-agent",
      }
      entry["aspects"] = aspects
      changed = True
    if changed:
      with open(yaml_path, "w") as f:
        yaml.safe_dump(entry, f, sort_keys=False, allow_unicode=True)
      fixed.append(os.path.join("catalog", os.path.basename(yaml_path)))
  return fixed


# Files that are never listed as children and never get a parent assigned: the
# manifest, reference layers, and the index sidecars themselves.
def _is_listable_entry_yaml(name: str) -> bool:
  return (
      name.endswith(".yaml")
      and name != "catalog.yaml"
      and name != "index.yaml"
      and not name.endswith(".ref.yaml")
  )


def _read_entry_yaml(yaml_path: str) -> dict:
  try:
    with open(yaml_path) as f:
      return yaml.safe_load(f) or {}
  except (OSError, yaml.YAMLError):
    return {}


def _md_cell(text: str) -> str:
  """Sanitize a value for a single Markdown table cell."""
  return (text or "").replace("|", "\\|").replace("\n", " ").strip()


def _build_index_hierarchy(
    output_dir: str | None,
    eg_full_name: str,
    entry_type: str,
    resource_name_prefix: str,
    topic: str,
    dir_meta: dict[str, tuple[str, str]] | None = None,
) -> None:
  """Generate a per-folder `index` entry and publish parent/child links.

  Walks the on-disk `catalog/` tree (robust to arbitrary nesting depth) and, for
  EVERY directory, writes an `index.yaml` + `index.overview.md` whose overview is
  a Markdown table of that directory's DIRECT children
  (`Path | Title | Type | Description`, type = folder/file). Then assigns
  `resource.parent` (Dataplex `parentEntry`) on every entry following the natural
  tree:

    * a leaf entry's parent  = the `index` of its own directory;
    * a directory's `index`'s parent = the `index` of the parent directory;
    * the root `catalog/index.yaml` has no parent.

  Index entries are full generic entries (with the required `generic` aspect) so
  `kcmd push` publishes them. The `glossaries/` reference subtree (pulled via
  `kcmd reference`) is skipped — those entries aren't ours to re-parent.

  Index ids are path-qualified relative to `catalog/`: `index`, `a/index`,
  `a/another_folder/index`, …
  """
  if not output_dir:
    return
  dir_meta = dir_meta or {}
  catalog_dir = os.path.join(output_dir, "catalog")
  if not os.path.isdir(catalog_dir):
    return

  # Quick guard: never emit an `index` for a directory that has no real entry
  # anywhere in its subtree (e.g. a KB category folder whose entries were all
  # scoped out / dropped in hybrid mode). Remove such entry-less folders
  # BOTTOM-UP first, so we neither write a stray index into them nor leave a
  # dangling child row in the parent index. Folders that only hold nested entries
  # (e.g. bigquery/<project>/<dataset>) are kept — their subtree has entries.
  def _subtree_has_entry(directory: str) -> bool:
    for _root, _dirs, files in os.walk(directory):
      if any(_is_listable_entry_yaml(f) for f in files):
        return True
    return False

  for directory in sorted(
      (root for root, _d, _f in os.walk(catalog_dir)),
      key=lambda p: p.count(os.sep),
      reverse=True,
  ):
    if directory == catalog_dir:
      continue
    rk_dir = os.path.relpath(directory, catalog_dir).replace(os.sep, "/")
    if rk_dir == "glossaries" or rk_dir.startswith("glossaries/"):
      continue  # read-only reference subtree (kcmd reference) — not ours to prune
    if os.path.isdir(directory) and not _subtree_has_entry(directory):
      for r, ds, fs in os.walk(directory, topdown=False):
        for f in fs:
          os.remove(os.path.join(r, f))
        for d in ds:
          os.rmdir(os.path.join(r, d))
      os.rmdir(directory)

  def rel_key(directory: str) -> str:
    rel = os.path.relpath(directory, catalog_dir)
    return "" if rel == "." else rel.replace(os.sep, "/")

  def index_id_for(directory: str) -> str:
    rk = rel_key(directory)
    return "index" if rk == "" else f"{rk}/index"

  # Collect every directory under catalog/ (including catalog/ itself), pruning
  # the reference-only `glossaries` subtree we don't own.
  all_dirs: list[str] = []
  for root, dirnames, _files in os.walk(catalog_dir):
    dirnames[:] = [d for d in dirnames if d != "glossaries"]
    all_dirs.append(root)

  # Pass 1: write index.yaml + index.overview.md per directory, BOTTOM-UP so a
  # folder row can read its subfolder's already-written index for title/desc.
  for directory in sorted(all_dirs, key=lambda p: p.count(os.sep), reverse=True):
    rk = rel_key(directory)
    iid = index_id_for(directory)
    children: list[tuple[str, str, str, str]] = []  # (path, title, type, desc)
    for name in sorted(os.listdir(directory)):
      full = os.path.join(directory, name)
      if os.path.isdir(full):
        if name == "glossaries":
          continue
        sub_index = os.path.join(full, "index.yaml")
        data = _read_entry_yaml(sub_index) if os.path.exists(sub_index) else {}
        res = data.get("resource") or {}
        title = res.get("displayName") or name
        path_rel = os.path.relpath(full, output_dir).replace(os.sep, "/")
        children.append((path_rel, title, "folder", res.get("description", "")))
      elif _is_listable_entry_yaml(name):
        data = _read_entry_yaml(full)
        res = data.get("resource") or {}
        path_rel = os.path.relpath(
            full[: -len(".yaml")], output_dir
        ).replace(os.sep, "/")
        title = res.get("displayName") or data.get("id") or os.path.basename(
            path_rel
        )
        children.append((path_rel, title, "file", res.get("description", "")))

    title, description = dir_meta.get(rk, (None, None))
    if rk == "":
      title = title or (topic or "Catalog")
      description = description or (
          f"Index of the catalog root ({len(children)} item(s))."
      )
    else:
      title = title or rk.split("/")[-1].replace("-", " ").replace("_", " ").title()
      description = description or (
          f"Index of catalog/{rk} ({len(children)} item(s))."
      )

    index_yaml = {
        "name": iid,
        "id": iid,
        "type": entry_type,
        "resource": {
            "name": f"{resource_name_prefix}/{iid}",
            "displayName": title,
            "description": description,
        },
        "aspects": {
            "dataplex-types.global.generic": {
                "type": "knowledge-base-index",
                "system": "enrichment-agent",
            },
        },
    }
    with open(os.path.join(directory, "index.yaml"), "w") as f:
      yaml.safe_dump(index_yaml, f, sort_keys=False, allow_unicode=True)

    lines = [
        f"# {title}",
        "",
        description,
        "",
        "| Path | Title | Type | Description |",
        "|------|-------|------|-------------|",
    ]
    for path_rel, ctitle, ctype, cdesc in children:
      lines.append(
          f"| {path_rel} | {_md_cell(ctitle)} | {ctype} | {_md_cell(cdesc)} |"
      )
    if not children:
      lines.append("| _(empty)_ |  |  |  |")
    with open(os.path.join(directory, "index.overview.md"), "w") as f:
      f.write("\n".join(lines) + "\n")

  # Pass 2: assign resource.parent on every entry (leaf + index) per the tree.
  for directory in all_dirs:
    is_root = os.path.abspath(directory) == os.path.abspath(catalog_dir)
    for name in sorted(os.listdir(directory)):
      if name == "index.yaml":
        parent_id = None if is_root else index_id_for(os.path.dirname(directory))
      elif _is_listable_entry_yaml(name):
        parent_id = index_id_for(directory)
      else:
        continue
      yaml_path = os.path.join(directory, name)
      data = _read_entry_yaml(yaml_path)
      if not data:
        continue
      resource = data.get("resource") or {}
      if parent_id is None:
        resource.pop("parent", None)
      else:
        resource["parent"] = f"{eg_full_name}/entries/{parent_id}"
      data["resource"] = resource
      with open(yaml_path, "w") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)


async def run(
    topic: str,
    docs: list[str],
    folders: list[str] | None,
    output_dir: str | None,
    model: str,
    entry_group: str,
    feedback_dir: str | None = None,
    feedback_files: list[str] | None = None,
    repo: str = "",
    repo_ref: str = "",
    repo_subdir: str = "",
    mcp_config: str = "",
    glossaries: list[str] | None = None,
    # HYBRID mode (doc mode + a BigQuery dataset): when `dataset` is set, doc mode
    # ALSO creates a context-overlay entry per table in that dataset (grounded by
    # the SAME docs), alongside the standalone KB entries it builds for knowledge
    # that doesn't belong on a single table. Empty `dataset` => plain doc mode.
    dataset: str = "",
    tables_filter: list[str] | None = None,
    include_usage: bool = True,
    usage_window_days: int = 30,
    anonymize_users: bool = False,
    usage_scope: str = "auto",
    output_format: str = "kcmd",
    confluence_spaces: list[str] | None = None,
    confluence_cql: list[str] | None = None,
    confluence_page_ids: list[str] | None = None,
    sharepoint_sites: list[str] | None = None,
    sharepoint_search: list[str] | None = None,
    sharepoint_file_ids: list[str] | None = None,
):
  # Doc mode generates per-KB-entry overviews. Feedback proposals target
  # tables/columns rather than KB entries, so there's no clean per-entry
  # routing — instead the loaded proposals are prepended globally to
  # every entry's writer prompt with the OVERRIDE directive. The writer
  # incorporates whichever proposals are relevant to the current entry
  # (typically by entry id / display name overlap with target_asset.name).
  all_feedback = feedback_tools.load_feedback(feedback_dir, feedback_files)
  feedback_block_global = (
      feedback_tools.proposals_to_prompt_block(all_feedback)
      if all_feedback
      else ""
  )
  if all_feedback:
    print(
        f"[Feedback] 📝 Loaded {len(all_feedback)} user-feedback"
        " proposal(s) — prepended to every entry writer prompt with"
        " OVERRIDE directive.",
        flush=True,
    )
  # entry_group is `project.location.entryGroupId`; derive the resource-name
  # prefix for the generated KB entries. All entries use the 1P generic entry
  # type (no per-run choice); the enriched content is their `overview` aspect.
  eg_parts = entry_group.split(".")
  if len(eg_parts) != 3:
    raise ValueError(
        "--entry-group must be `project.location.entryGroupId` (got"
        f" '{entry_group}')."
    )
  eg_project, eg_location, eg_id = eg_parts
  entry_type = _GENERIC_ENTRY_TYPE
  resource_name_prefix = (
      f"projects/{eg_project}/locations/{eg_location}/catalog"
  )
  # Full Dataplex EntryGroup resource name — used to build the `resource.parent`
  # (Dataplex `parentEntry`) of each entry. Parent values must be FULL resource
  # names (`<eg>/entries/<parent-id>`), unlike the local `name:` which is just
  # the entry id (kcmd re-prepends `<eg>/entries/` at push — see
  # toolbox/mdcode/src/libts/sources/entrygroup.ts).
  eg_full_name = (
      f"projects/{eg_project}/locations/{eg_location}/entryGroups/{eg_id}"
  )

  # Scaffold the manifest up front with `kcmd init --entry-group` AND pull any
  # pre-existing entries from KC. The pulled entries become seed inputs to
  # the EnumerationAgent (so they MUST appear in the output even if there's
  # little new content to enrich them), and their existing overview is fed
  # to the per-entry writer as additional grounding context — see
  # _write_one_kb_entry.
  # Optional glossary: when supplied, the entry-group manifest declares
  # `entryLinks: [related]` so existing entry→term links round-trip via
  # pull/push, and after KB entries are generated we run the
  # EntityLinkingAgent to tag each one with relevant glossary terms.
  glossary_scope = None
  if glossaries:
    glossary_scope, warning = kcmd_tools.build_glossary_scope(glossaries)
    if glossary_scope is None:
      print(
          f"[Linking] ⚠️  {warning} — disabling glossary linking.", flush=True
      )
      glossaries = None
    elif warning:
      print(f"[Linking] ⚠️  {warning}", flush=True)

  # HYBRID: a BigQuery dataset was also passed. Scaffold with the OVERLAY
  # manifest (a superset of the entry-group manifest) so ONE catalog.yaml hosts
  # both the doc KB entries (generic+overview) and the per-table context overlays
  # (generic+overview+queries), with the dataset's 1P tables referenced
  # read-only. Plain doc mode keeps the entry-group-only scaffold.
  hybrid = bool(dataset)
  ref_project = ref_dataset = ""
  if hybrid:
    from modes import table_mode  # lazy import: avoid load-time import cycles
    ref_project, ref_dataset = table_mode._parse_dataset(dataset)

  existing_kb_entries = []
  if output_dir:
    if hybrid:
      ok, msg = kcmd_tools.init_reference_and_pull(
          output_dir, entry_group, ref_project, ref_dataset, entry_type,
          bool(glossary_scope),
      )
      print(
          f"[kcmd] HYBRID init: reference {ref_project}.{ref_dataset} + pull"
          f" --entry-group {entry_group}"
          f"{' (with glossary links)' if glossary_scope else ''}:"
          f" {'OK' if ok else 'FAILED'} {msg}",
          flush=True,
      )
    else:
      ok, msg = kcmd_tools.init_pull_entry_group(
          output_dir, entry_group, entry_type, bool(glossary_scope)
      )
      print(
          f"[kcmd] init+pull --entry-group {entry_group}"
          f"{' (with glossary links)' if glossary_scope else ''}:"
          f" {'OK' if ok else 'FAILED'} {msg}",
          flush=True,
      )
    if glossary_scope:
      print(
          f"[kcmd] 🔎 Pulling glossary terms ({glossary_scope}) as"
          " reference ...",
          flush=True,
      )
      # The reference pull only succeeds if `reference.scope` is the
      # glossary; we temp-swap catalog.yaml and restore (helper does both).
      ok_g, msg_g = kcmd_tools.pull_glossary_as_reference(
          output_dir, eg_project, glossary_scope
      )
      print(
          f"[kcmd] {'OK' if ok_g else '⚠️  FAILED'} (glossary"
          f" reference): {msg_g}",
          flush=True,
      )
    pulled_entries = kcmd_tools.list_kb_entries(output_dir)
    # Folder `index` entries (id `index` or `<path>/index`) are regenerated from
    # scratch every run by _build_index_hierarchy — never seed them back into the
    # enumerator (they're navigation entries, not content), though their pulled
    # files ARE deleted below so they don't linger at the EG-nested path.
    existing_kb_entries = [
        e
        for e in pulled_entries
        if e["id"] != "index" and not e["id"].endswith("/index")
    ]
    if existing_kb_entries:
      print(
          f"[kcmd] pulled {len(existing_kb_entries)} pre-existing KB entries —"
          " they will be preserved as seed entries.",
          flush=True,
      )
    else:
      print(
          f"[kcmd] entry group is empty — no seed entries to preserve.",
          flush=True,
      )
    # The pulled entries were read into memory above (with their existing
    # overview); their on-disk files live at the EG-nested catalog path. Every
    # entry is re-emitted into a category subdir below, so remove the pulled
    # originals now to keep a single source of truth (avoids duplicate entries
    # on push). Index entries are deleted too (regenerated fresh).
    for _e in pulled_entries:
      _yp = _e.get("yaml_path")
      if not _yp:
        continue
      for _p in (_yp, _yp[: -len(".yaml")] + ".overview.md"):
        try:
          if os.path.exists(_p):
            os.remove(_p)
        except OSError:
          pass

  # Maps a file id/url to its known Drive mimeType (empty = treat as a Google
  # Doc and let fetch_doc_text dispatch). Crawled gdoc links default to "".
  mime_by_id = {}
  # v5 #2: also remember the modifiedTime for cache validation on folder seeds.
  mtime_by_id = {}
  start_docs = list(docs or [])  # explicit --docs: authoritative depth-0 spine
  folder_seed_urls = []  # folder files: injected as depth-1 children
  folder_files = []

  # Split local-markdown inputs out from Drive inputs (see
  # _partition_doc_inputs): a local .md file via --docs is a depth-0 spine; a
  # local dir via --docs/--folder contributes its .md files as depth-1
  # children. Injected after the crawl below.
  start_docs, drive_folders, local_spine_md, local_child_md = (
      _partition_doc_inputs(start_docs, folders)
  )
  if local_spine_md or local_child_md:
    print(
        f"[Local] 📂 Markdown inputs: {len(local_spine_md)} spine file(s),"
        f" {len(local_child_md)} folder child(ren). Relative paths resolve from"
        f" CWD: {os.getcwd()}",
        flush=True,
    )

  drive_folders = [extract_folder_id(f) for f in drive_folders if f]

  # Seed additional inputs by listing each Drive folder (Docs/Sheets/Slides/PDF).
  for folder in drive_folders:
    print(f"[Crawler] 📁 Listing Drive folder: {folder}", flush=True)
    one = list_folder_files(folder)
    print(f"[Crawler] 📁 Found {len(one)} file(s) in folder.", flush=True)
    folder_files.extend(one)
    for f in one:
      fid = f.get("id")
      if not fid:
        continue
      mime_by_id[fid] = f.get("mimeType", "")
      if f.get("modifiedTime"):
        mtime_by_id[fid] = f.get("modifiedTime")
      folder_seed_urls.append(fid)

  # When seeding purely from a folder there is no authoritative document to be
  # the Master Scope, so synthesize one and treat the folder files as its
  # depth-1 children. If explicit --docs were given, those remain the spine.
  synthetic_scope_text = ""
  scope_files = list(folder_files) + [
      {"name": os.path.basename(p), "mimeType": "text/markdown"}
      for p in local_child_md
  ]
  if scope_files and not start_docs and not local_spine_md:
    synthetic_scope_text = _build_synthetic_scope(topic, scope_files)

  print("=" * 60)
  print(
      f"=== ADK DOC AGENT: Parallel Depth-Weighted Knowledge Base"
      f" Enrichment ==="
  )
  print(f"Topic: {topic}")
  print(
      f"Start Docs: {len(start_docs)} | Folder files (depth 1):"
      f" {len(folder_seed_urls)}"
  )
  print("=" * 60)

  # 1. Parallel Crawl
  # Seeds are injected at specific depths: explicit --docs at depth 0 (the
  # authoritative spine), folder files at depth 1 (children of the synthetic
  # Master Scope). This keeps a folder's heterogeneous files from flattening
  # into depth 0 and drowning the scope.
  seeds_by_depth = {0: list(start_docs)}
  if folder_seed_urls:
    seeds_by_depth.setdefault(1, []).extend(folder_seed_urls)

  visited_ids = set()
  carried_urls = []  # links discovered while crawling the previous depth
  all_fetched_docs = []  # list of (url, depth, content)

  for depth in range(MAX_DEPTH + 1):
    # Merge carried-over crawl links with any seeds registered for this depth.
    current_level_urls = carried_urls + seeds_by_depth.get(depth, [])
    if not current_level_urls:
      carried_urls = []
      continue  # deeper seeds (e.g. folder files at depth 1) may still arrive

    fetch_tasks = []
    for url in current_level_urls:
      doc_id = extract_gdoc_id(url)
      if doc_id not in visited_ids:
        visited_ids.add(doc_id)
        fetch_tasks.append(
            _fetch_url(
                url,
                depth,
                mime_by_id.get(doc_id, mime_by_id.get(url, "")),
                modified_time=mtime_by_id.get(doc_id, mtime_by_id.get(url)),
            )
        )

    results = await asyncio.gather(*fetch_tasks) if fetch_tasks else []
    all_fetched_docs.extend(results)

    next_level_urls = set()
    if depth < MAX_DEPTH:
      for url, d, content in results:
        links = set(
            re.findall(
                r"https://docs\.google\.com/document/d/[a-zA-Z0-9-_]+", content
            )
        )
        for link in links:
          if extract_gdoc_id(link) not in visited_ids:
            next_level_urls.add(link)
    carried_urls = list(next_level_urls)

  print(
      f"\n[Crawler] 🏁 Finished fetching {len(all_fetched_docs)} documents"
      " total.\n"
  )

  # Inject local markdown as already-fetched docs (read from disk, no Drive
  # round-trip). Spine files at depth 0 (become Master Scope), folder/dir files
  # at depth 1 — exactly mirroring --docs / --folder for Google Docs. mtime is
  # registered so the per-doc summary cache keys on (path, mtime) like Drive
  # docs.
  for p in local_spine_md:
    all_fetched_docs.append((p, 0, read_local_md(p)))
    mtime_by_id[p] = str(os.path.getmtime(p))
  for p in local_child_md:
    all_fetched_docs.append((p, 1, read_local_md(p)))
    mtime_by_id[p] = str(os.path.getmtime(p))
  if local_spine_md or local_child_md:
    print(
        f"[Local] 📄 Injected {len(local_spine_md) + len(local_child_md)} local"
        f" markdown file(s): {len(local_spine_md)} spine, {len(local_child_md)}"
        " folder child(ren).",
        flush=True,
    )

  # Extract Depth 0 documents as Master Scope. When seeding from a folder
  # there are no depth-0 docs, so the synthetic scope stands in as the spine.
  master_scope_docs = [doc for doc in all_fetched_docs if doc[1] == 0]
  master_scope_text = synthetic_scope_text
  if master_scope_text:
    master_scope_text += "\n\n"
  for url, depth, content in master_scope_docs:
    master_scope_text += (
        f"--- MASTER SCOPE DOC: {url} ---\n{content[:50000]}\n\n"
    )

  # 2a. Stage-1 Map (cache-aware): topic-NEUTRAL per-doc summary card.
  # Runs on PER_DOC_SUMMARIZER_MODEL (Flash) at higher concurrency since each
  # call is one small doc in / one short card out — no batch context, well
  # under Flash routing limits. Cache key = (doc_id, modified_time) under
  # ~/.kc_enrich_cache/summaries/ when KC_ENRICH_CACHE_MODE=summary (default);
  # HIT skips the LLM call entirely, so warm re-runs only pay for Stage-2.
  cache_mode = get_cache_mode()
  print(
      "[Agent] 🧠 Stage 1: per-doc summary (cache mode:"
      f" {cache_mode}, model: {PER_DOC_SUMMARIZER_MODEL}, concurrency:"
      f" {PER_DOC_CONCURRENCY})...",
      flush=True,
  )
  # Stage-1 gets its own semaphore so Flash throughput isn't gated by
  # CONCURRENCY_LIMIT (which is sized for Pro batch summarizer / writer fan-out).
  per_doc_sem = asyncio.Semaphore(PER_DOC_CONCURRENCY)
  # Stage 2+ continues to use the Pro-sized semaphore.
  sem = asyncio.Semaphore(CONCURRENCY_LIMIT)
  # Accumulate enrichment-agent token usage across Stage 1 + Stage 2 phases.
  usage_acc = {"input": 0, "output": 0}

  per_doc_tasks = []
  for url, depth, content in all_fetched_docs:
    doc_id = extract_gdoc_id(url)
    per_doc_tasks.append(
        _summarize_one_doc(
            url,
            content,
            mtime_by_id.get(doc_id, mtime_by_id.get(url)),
            per_doc_sem,
            PER_DOC_SUMMARIZER_MODEL,
            usage_acc,
        )
    )
  per_doc_summaries_text = await asyncio.gather(*per_doc_tasks)
  per_doc_cards = [
      (url, depth, summary)
      for (url, depth, _content), summary in zip(
          all_fetched_docs, per_doc_summaries_text
      )
  ]
  print(
      f"\n[Agent] ✅ Stage 1 done: {len(per_doc_cards)} doc card(s).",
      flush=True,
  )

  # 2a-bis. Source-code source (optional): explore a GitHub repo agentically.
  # NOTE: code component cards are deliberately NOT fed through Stage-2 (the
  # topic-shaped reduce), because that step drops anything off-topic — which
  # silently discarded code components whenever the run's --topic was framed
  # around the docs. Instead we (a) append the code cards verbatim to the
  # compiled summary AFTER the reduce, so the enumerator + per-entry writer see
  # the real code context, and (b) add each component as a seed entry below so
  # it is GUARANTEED to become its own KB entry regardless of topic phrasing.
  code_cards = []
  if repo:
    code_cards = await github_tools.gather_repo_context(
        repo,
        repo_ref,
        repo_subdir,
        topic,
        model,
        usage_acc,
        mcp_config_path=mcp_config or None,
    )

  # Confluence corpus (optional): each page becomes its own seed entry (so it
  # always surfaces as a KB entry) and its card is appended post-reduce.
  confluence_cards = await confluence_tools.gather_confluence_context(
      confluence_spaces,
      confluence_cql,
      confluence_page_ids,
      topic,
      model,
      usage_acc,
      mcp_config_path=mcp_config or None,
  )

  # SharePoint corpus (optional): same treatment as the Confluence cards.
  sharepoint_cards = await sharepoint_tools.gather_sharepoint_context(
      sharepoint_sites,
      sharepoint_search,
      sharepoint_file_ids,
      topic,
      model,
      usage_acc,
  )

  # 2b. Stage-2 Reduce (uncached): topic-shaped batch reduction over the
  # neutral per-doc cards. Cards are ~5× smaller than raw doc text, so each
  # batch call is cheap relative to the legacy raw-text summarizer.
  print(
      "[Agent] 🎯 Stage 2: topic-shaped reduce (batches of"
      f" {MAX_BATCH_SIZE})...",
      flush=True,
  )
  reduce_tasks = []
  for i in range(0, len(per_doc_cards), MAX_BATCH_SIZE):
    batch = per_doc_cards[i : i + MAX_BATCH_SIZE]
    reduce_tasks.append(
        _reduce_summaries_with_topic(
            topic, master_scope_text, batch, sem, model, usage_acc
        )
    )
  all_summaries = await asyncio.gather(*reduce_tasks)
  print(f"\n[Agent] ✅ Stage 2 done: {len(all_summaries)} reduced batch(es).\n")

  compiled_summary = "\n\n".join(
      [f"--- BATCH SUMMARY {i+1} ---\n{s}" for i, s in enumerate(all_summaries)]
  )
  # NOTE (shared-concepts across modes): this `compiled_summary` is doc mode's
  # flavor of the cross-document/cross-table concept sharing that table mode +
  # context-overlay mode do via the structured <CONCEPTS> mechanism
  # (table_mode._aggregate_concepts + build_shared_concept_block). Here every
  # per-entry writer is grounded in the SAME reduced cross-document summary, so a
  # fact stated in one doc can inform an entry sourced primarily from another.
  # The structured per-table injection is applied to the HYBRID overlay side via
  # context_overlay_mode.generate_overlays (called below); the standalone KB
  # entries intentionally keep this map-reduce flavor (see plan: "doc keeps its
  # flavor").

  # Append code component cards verbatim (post-reduce, so they're not filtered
  # by the topic lens). The per-entry writer's _slice_summary_for_entry will
  # match these by display_name when grounding each code entry.
  code_seed_entries = []
  if code_cards:
    code_block = "\n\n".join(
        f"--- CODE COMPONENT: {c['name']} ({c['url']}) ---\n{c['content']}"
        for c in code_cards
    )
    compiled_summary += (
        "\n\n--- SOURCE CODE COMPONENTS (from "
        f"{repo}{' /' + repo_subdir if repo_subdir else ''}) ---\n\n"
        + code_block
    )
    code_seed_entries = [
        {
            "id": _slugify(c["name"]),
            "display_name": c["name"],
            "kind": "kb",
        }
        for c in code_cards
    ]

  # Append Confluence page cards verbatim (same post-reduce rationale as
  # code cards above) and seed each as its own KB entry.
  confluence_seed_entries = []
  if confluence_cards:
    conf_block = "\n\n".join(
        f"--- CONFLUENCE PAGE: {c['name']} ({c['url']}) ---\n{c['content']}"
        for c in confluence_cards
    )
    compiled_summary += (
        "\n\n--- CONFLUENCE PAGES ---\n\n" + conf_block
    )
    confluence_seed_entries = [
        {
            "id": _slugify(c["name"]),
            "display_name": c["name"],
            "kind": "kb",
        }
        for c in confluence_cards
    ]

  # Append SharePoint file cards verbatim (same rationale).
  sharepoint_seed_entries = []
  if sharepoint_cards:
    sp_block = "\n\n".join(
        f"--- SHAREPOINT FILE: {c['name']} ({c['url']}) ---\n{c['content']}"
        for c in sharepoint_cards
    )
    compiled_summary += (
        "\n\n--- SHAREPOINT FILES ---\n\n" + sp_block
    )
    sharepoint_seed_entries = [
        {
            "id": _slugify(c["name"]),
            "display_name": c["name"],
            "kind": "kb",
        }
        for c in sharepoint_cards
    ]

  # HYBRID (reorder + feed): generate the per-table context-overlay entries FIRST,
  # so the KB enumeration below can be scoped to ONLY the cross-cutting knowledge
  # the overlays do NOT already own. The overlays own each table's schema,
  # per-table facts, AND the cross-table relationships involving that table; KB
  # entries must be the complement (dataset-wide concepts, multi-table processes,
  # glossary, cross-table metrics) — never a restatement of a single table.
  overlay_core = None
  scoping_guidance = ""
  if hybrid and output_dir:
    from modes import context_overlay_mode  # lazy import: avoid cycles
    print("=" * 60, flush=True)
    print(
        f"[Hybrid] 🔱 Generating context-overlay entries FIRST for"
        f" {ref_project}.{ref_dataset}; KB entries will be scoped to the"
        " cross-cutting complement ...",
        flush=True,
    )
    overlay_core = await context_overlay_mode.generate_overlays(
        output_dir, ref_project, ref_dataset, eg_project, eg_location, eg_id,
        entry_group, topic, model, folders, docs, all_feedback, glossary_scope,
        usage_acc,
        tables_filter=tables_filter, include_usage=include_usage,
        usage_window_days=usage_window_days, anonymize_users=anonymize_users,
        usage_scope=usage_scope, repo=repo, repo_ref=repo_ref,
        repo_subdir=repo_subdir, mcp_config=mcp_config,
        # Reuse the Confluence/SharePoint cards already gathered above for the KB
        # entries so the overlays are grounded by the same corpus without a second
        # fetch (passing the cards skips the gather in _prepare_all_docs).
        confluence_docs=confluence_cards,
        sharepoint_docs=sharepoint_cards,
        # doc_mode builds ONE combined index over BOTH the KB folders and the
        # overlay folders (merging the overlay dir_meta), so generate_overlays
        # must not build its own -- avoids a double pass that relabels folders.
        build_index=False,
    )
    if overlay_core and overlay_core.get("results"):
      covered_tables = [m["table"] for (m, _d, _t, _es) in overlay_core["results"]]
      digests = []
      for (m, _d, text, _es) in overlay_core["results"]:
        snippet = " ".join((text or "").split())[:500]
        digests.append(f"- `{m['table']}`: {snippet}")
      print(
          f"[Hybrid] ✅ Generated {len(covered_tables)} context-overlay entr(ies)"
          f" for: {', '.join(covered_tables)}",
          flush=True,
      )
      scoping_guidance = (
          "HYBRID MODE. Per-table CONTEXT-OVERLAY entries ALREADY EXIST for these"
          f" dataset tables and OWN all of their knowledge: {', '.join(covered_tables)}.\n"
          "Each overlay already covers that table's purpose, schema/columns,"
          " per-table facts, AND every cross-table relationship that INVOLVES that"
          " table (foreign keys, joins, lineage). What each overlay already"
          " conveys:\n" + "\n".join(digests) + "\n\n"
          "Enumerate ADDITIONAL knowledge-base entries ONLY for knowledge that"
          " does NOT belong in any single table's overlay and could not sensibly"
          " live there — e.g. dataset-wide domain/business concepts, multi-step"
          " processes or workflows spanning several tables, glossary/business-term"
          " definitions, or metrics/KPIs defined ACROSS tables. DO NOT create an"
          " entry that is 'about' one of the tables above, that restates a table's"
          " schema/columns/purpose, or that merely describes a relationship"
          " between those tables — the overlays already own ALL of that. Prefer"
          " FEWER entries; an EMPTY set is correct when the source is wholly"
          " table-specific."
      )

  # 3. ENUMERATE — one schema-validated call producing the canonical entry list.
  # Pre-existing KB entries (from kcmd pull) are passed as seed_entries so
  # they MUST appear in the output even if the new docs add little. The
  # enumerator may add other entries it discovers in the new context. Code
  # components are seeded too, so they always become their own entries.
  seed_entries = [
      {
          "id": e["id"],
          "display_name": e["display_name"] or e["id"],
          "kind": "kb",
      }
      for e in existing_kb_entries
  ] + code_seed_entries + confluence_seed_entries + sharepoint_seed_entries
  if seed_entries:
    print(
        f"[Agent] 🧭 Enumerating with {len(seed_entries)} seed entries from"
        " KC...",
        flush=True,
    )
  else:
    print(
        "[Agent] 🧭 Enumerating canonical entries from compiled summary...",
        flush=True,
    )
  enumeration = await common.run_enumeration(
      topic,
      compiled_summary,
      seed_entries=seed_entries or None,
      model=model,
      usage_acc=usage_acc,
      scoping_guidance=scoping_guidance,
  )
  # HYBRID deterministic backstop: even with the scoping guidance, drop any KB
  # entry that collides by name with a table that already has its own overlay --
  # such an entry is by definition table-specific and is owned by the overlay, so
  # it must not be duplicated as a standalone KB entry.
  if overlay_core and overlay_core.get("results"):
    _norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
    covered_norm = {
        _norm(m["table"]) for (m, _d, _t, _es) in overlay_core["results"]
    }
    dropped = []
    for cat in enumeration.categories:
      kept = []
      for e in cat.entries:
        if _norm(e.id) in covered_norm or _norm(e.display_name) in covered_norm:
          dropped.append(e.display_name or e.id)
        else:
          kept.append(e)
      cat.entries = kept
    enumeration.categories = [c for c in enumeration.categories if c.entries]
    if dropped:
      print(
          f"[Hybrid] 🧹 Dropped {len(dropped)} table-duplicate KB entr(ies)"
          f" (owned by overlays): {dropped}",
          flush=True,
      )
  n_entries = sum(len(c.entries) for c in enumeration.categories)
  print(
      f"[Agent] ✅ Enumerated {n_entries} entries across"
      f" {len(enumeration.categories)} categories:"
      f" {[c.id for c in enumeration.categories]}",
      flush=True,
  )

  # Build a lookup from canonical entry id → existing overview content, so
  # the per-entry writer can use it as additional grounding (and so we don't
  # regress KC content when there's little new material for an entry).
  existing_overview_by_id = {
      e["id"]: e["existing_overview"]
      for e in existing_kb_entries
      if e.get("existing_overview")
  }

  # 4. FAN OUT — write each entry independently with its own writer call.
  # Per-entry inputs are small (one entry's slice of context) and the writer
  # uses Flash. v2.5 optimization #3: 12 → 24 (Flash quota and the smaller per-
  # call payload allow it).
  write_concurrency = max(CONCURRENCY_LIMIT, 24)
  print(
      f"[Agent] 🏗️  Writing {n_entries} entries in parallel (concurrency"
      f" {write_concurrency})...",
      flush=True,
  )
  sem = asyncio.Semaphore(write_concurrency)
  write_tasks = []
  for cat in enumeration.categories:
    for entry in cat.entries:
      write_tasks.append(
          _write_one_kb_entry(
              entry,
              cat,
              topic,
              compiled_summary,
              output_dir,
              entry_type,
              resource_name_prefix,
              sem,
              model,
              usage_acc,
              existing_overview=existing_overview_by_id.get(entry.id, ""),
              feedback_block=feedback_block_global,
          )
      )
  write_results = await asyncio.gather(*write_tasks)
  all_overviews = [body for (body, _es) in write_results]
  entry_states = [es for (_body, es) in write_results if es is not None]

  # Optional entity-level linking: when --glossaries was supplied, tag each
  # KB entry with related glossary terms. The link is anchored on the entry
  # itself (SOURCE = entry in the user's EG, TARGET = glossary term), so the
  # link resource lives in the user's EG and rounds-trip cleanly via kcmd
  # pull/push — full version control.
  if glossary_scope and output_dir and entry_states:
    import linking

    entries_for_linking = []
    for es in entry_states:
      # entry_id is path-qualified (`a/m`); derive the yaml path from the
      # overview sidecar rather than `category_dir + entry_id` (which would
      # double the folder).
      entry_yaml_path = _yaml_path_for(es.overview_path)
      if not entry_yaml_path or not os.path.exists(entry_yaml_path):
        continue
      summary = (es.overview_body or "")[:5000]
      entries_for_linking.append((entry_yaml_path, es.display_name, summary))

    def _inject_kb_links(path: str, new_links: list[dict]):
      # Inject as `definition` (directed: SOURCE=KB entry, TARGET=term) to
      # match table-mode push reconciliation semantics. Semantically
      # "related" would fit better but the reconciler keys on SOURCE/TARGET
      # ref types and undirected (`related`) collapses keys in dedup.
      with open(path) as f:
        data = yaml.safe_load(f) or {}
      data.setdefault("links", {}).setdefault("definition", [])
      existing_ids = {l.get("id") for l in data["links"]["definition"]}
      for nl in new_links:
        if nl["id"] not in existing_ids:
          data["links"]["definition"].append(nl)
      with open(path, "w") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)

    print("[Linking] 🔗 Tagging KB entries with glossary terms ...", flush=True)
    n = await linking.apply_entity_linking(
        output_dir, model, entries_for_linking, _inject_kb_links, usage_acc
    )
    print(
        f"[Linking] ✅ Tagged {n} entry/entries with related terms.", flush=True
    )

  # HYBRID overlays were generated BEFORE enumeration (see the "[Hybrid] generate
  # overlays FIRST" block above) so the KB entries could be scoped to the
  # cross-cutting complement. `overlay_core` is already populated here.

  # Generate the per-folder `index` entries and publish parent/child links over
  # the final on-disk tree (after all entries + any glossary links are written).
  if output_dir:
    dir_meta = {
        cat.id: (cat.title, cat.description) for cat in enumeration.categories
    }
    # HYBRID: also label the per-table overlay folders (bigquery/<proj>/<ds>/
    # <table>) so the ONE combined index pass covers KB folders AND overlay
    # folders with meaningful titles.
    if overlay_core:
      dir_meta.update(overlay_core.get("dir_meta") or {})
    print(
        "[Agent] 🗂️  Building folder index entries + parent/child links ...",
        flush=True,
    )
    _build_index_hierarchy(
        output_dir,
        eg_full_name,
        entry_type,
        resource_name_prefix,
        topic,
        dir_meta,
    )

  # Trajectory persists: per-doc fetches (the "tools" of doc mode) plus the
  # enumerated entry list so eval can ground scoring in BOTH what was read and
  # what was emitted.
  # Local markdown inputs are read off disk (read_local_md), not fetched from
  # Drive (fetch_gdoc); label each tool use by its actual source so eval counts
  # them correctly instead of attributing local files to fetch_gdoc.
  tool_uses = [
      {
          "name": "read_local_md" if is_local_path(url) else "fetch_gdoc",
          "args": {"url": url, "depth": depth},
      }
      for (url, depth, _content) in all_fetched_docs
  ]
  tool_responses = [
      {
          "name": "read_local_md" if is_local_path(url) else "fetch_gdoc",
          "response": {"url": url, "depth": depth, "content": content[:50000]},
      }
      for (url, depth, content) in all_fetched_docs
  ]
  for c in code_cards:
    tool_uses.append({"name": "explore_repo", "args": {"component": c["name"]}})
    tool_responses.append({
        "name": "explore_repo",
        "response": {"url": c["url"], "content": c["content"]},
    })
  for c in confluence_cards:
    tool_uses.append(
        {"name": "read_confluence", "args": {"page": c["name"]}}
    )
    tool_responses.append({
        "name": "read_confluence",
        "response": {"url": c["url"], "content": c["content"]},
    })
  for c in sharepoint_cards:
    tool_uses.append(
        {"name": "read_sharepoint", "args": {"file": c["name"]}}
    )
    tool_responses.append({
        "name": "read_sharepoint",
        "response": {"url": c["url"], "content": c["content"]},
    })
  tool_uses.append({"name": "enumerate", "args": {"topic": topic}})
  tool_responses.append(
      {"name": "enumerate", "response": enumeration.model_dump()}
  )
  final_text = "\n\n".join(t for t in all_overviews if t)
  # HYBRID: fold the overlay slice of the trajectory in so eval/trajectory sees
  # BOTH the doc tools (fetch_gdoc/read_local_md) and the overlay tools
  # (reference_table/route_docs); tag the run "hybrid".
  if overlay_core:
    tool_uses = tool_uses + overlay_core["tool_uses"]
    tool_responses = tool_responses + overlay_core["tool_responses"]
    final_text = (final_text + "\n\n" + overlay_core["final_text"]).strip()
  common.write_trajectory(
      output_dir,
      "hybrid" if hybrid else "doc",
      f"TOPIC: {topic}"
      + (f" | DATASET: {ref_project}.{ref_dataset}" if hybrid else ""),
      tool_uses,
      tool_responses,
      final_text,
      usage_acc,
  )
  from tools.drive_tools import get_cache_stats

  print(f"[Cache] doc-fetch stats: {get_cache_stats()}", flush=True)

  # OKF output: convert the finished catalog/ tree into an OKF bundle/.
  common.maybe_convert_to_okf(output_dir, output_format)

  # Build the refinement session (consumed by agent_runner --interactive).
  # HYBRID: include the overlay entries so a later refine turn can target them.
  session_entries = {es.entry_id: es for es in entry_states}
  if overlay_core:
    for (_m, _d, _t, es) in overlay_core["results"]:
      session_entries[es.entry_id] = es
  return refine.EnrichmentSession(
      mode="hybrid" if hybrid else "doc",
      topic=topic,
      model=model,
      output_dir=output_dir or "",
      entries=session_entries,
      usage_acc=usage_acc,
      # Phase-2 state so a `reenumerate` refinement can re-run enumeration over
      # the same compiled context and write/move/delete entries without
      # re-reading any source docs (see refine._reenumerate -> apply_reenumeration).
      enum_context=compiled_summary,
      writer_params={
          "entry_type": entry_type,
          "resource_name_prefix": resource_name_prefix,
          "eg_full_name": eg_full_name,
          "feedback_block_global": feedback_block_global,
      },
      traj_meta={
          "agent_type": "doc",
          "user_input": f"TOPIC: {topic}",
          "tool_uses": tool_uses,
          "tool_responses": tool_responses,
      },
  )


def _slice_summary_for_entry(entry, compiled_summary: str) -> str:
  """Return a focused slice of the compiled summary for one entry.

  We try to extract just the paragraphs that mention the entry's display_name
  or any alias. If nothing matches (the summary might use the canonical id),
  fall back to the entire compiled summary capped at 60K chars (still well
  under the EntryWriterAgent's Flash limit per single-entry call).
  """
  needles = [entry.display_name] + list(entry.aliases) + [entry.id]
  needles_lower = [n.lower() for n in needles if n]
  paragraphs = [
      p
      for p in compiled_summary.split("\n\n")
      if any(n in p.lower() for n in needles_lower)
  ]
  if paragraphs:
    joined = "\n\n".join(paragraphs)
    return joined[:60000] if len(joined) > 60000 else joined
  return compiled_summary[:60000]


async def _write_one_kb_entry(
    entry,
    category,
    topic: str,
    compiled_summary: str,
    output_dir: str | None,
    entry_type: str,
    resource_name_prefix: str,
    sem: asyncio.Semaphore,
    model: str,
    usage_acc: dict,
    existing_overview: str = "",
    feedback_block: str = "",
) -> str:
  """Generate one entry's YAML + overview.md and write to disk.

  Layout: catalog/{category.id}/{entry.id}.yaml +
  catalog/{category.id}/{entry.id}.overview.md
  The YAML is composed deterministically here (no LLM); the overview body
  comes from a direct Flash call (v2.5 #4: bypassing ADK runner overhead).

  If `existing_overview` is non-empty (this entry already exists in KC, pulled
  via `kcmd init+pull`), the writer is told to update/extend it rather than
  write from scratch — and is forbidden from dropping any factual content
  from the existing overview unless directly contradicted by new context.
  """
  async with sem:
    context_slice = _slice_summary_for_entry(entry, compiled_summary)
    sources_block = (
        "\n".join(f"  - {u}" for u in entry.primary_source_urls)
        or "  (none listed)"
    )
    existing_block = ""
    if existing_overview:
      existing_block = (
          "\nEXISTING OVERVIEW (already published in Knowledge Catalog for"
          f" this entry):\n```markdown\n{existing_overview[:30000]}\n```\nUse"
          " the existing overview as the foundation. Update or extend it with"
          " the new context above. Do NOT drop any factual content from the"
          " existing overview unless it is directly contradicted by new"
          " context — preservation matters even if there's little new material"
          " to add for this entry.\n"
      )
    user_prompt = (
        f"TOPIC: {topic}\n\nENTRY CANONICAL NAME: {entry.display_name}\nENTRY"
        f" ID: {entry.id}\nCATEGORY: {category.title} ({category.id})\nALIASES:"
        f" {', '.join(entry.aliases) if entry.aliases else '(none)'}\nDESCRIPTION:"
        f" {entry.description}\nPRIMARY SOURCE"
        f" URLS:\n{sources_block}\n\nRELEVANT CONTEXT (excerpts of source"
        " summaries that mention this"
        f" entry):\n{context_slice}\n{existing_block}\nWrite the overview"
        " Markdown body for this entry now."
        + feedback_block
    )
    body = await common.generate_text_direct(
        ENTRY_WRITER_INSTRUCTION,
        user_prompt,
        _LIGHT_MODEL_FOR_WRITER,
        usage_acc,
    )

  if not output_dir:
    return body, None
  # Path-qualified id: `<category>/<entry>` (e.g. `a/m`). This makes the entry id
  # unique across categories and mirrors the on-disk tree, so the published
  # Dataplex name carries its folder. Pulled pre-existing entries already arrive
  # with a qualified id (it contains '/') — keep it stable instead of
  # re-prefixing, so ids round-trip across runs. The on-disk location is derived
  # FROM the id, so folder == id path == published parent chain.
  # `resource.parent` is NOT set here — the index pass (_build_index_hierarchy)
  # assigns every entry's parent from its location.
  full_id = entry.id if "/" in entry.id else f"{category.id}/{entry.id}"
  top_category = full_id.split("/")[0]
  catalog_dir = os.path.join(output_dir, "catalog")
  yaml_path = os.path.join(catalog_dir, f"{full_id}.yaml")
  overview_path = os.path.join(catalog_dir, f"{full_id}.overview.md")
  # full_id may be nested (e.g. `a/sub/m`) — create the parent dirs.
  os.makedirs(os.path.dirname(yaml_path), exist_ok=True)
  # YAML: deterministic, no LLM. Includes the required `generic` aspect and a
  # `category:` field (the top path segment) so downstream consumers can group.
  # `name:` is the LOCAL name (the path-qualified entry id). kcmd's entrygroup
  # source.serviceName() prepends `<eg-path>/entries/` to produce the full
  # Dataplex resource path at push time — see toolbox/mdcode/src/libts/
  # sources/entrygroup.ts line 59-70. Setting `name:` to the full path here
  # causes a double-prefix at push.
  entry_yaml = {
      "name": full_id,
      "id": full_id,
      "type": entry_type,
      "category": top_category,
      "resource": {
          "name": f"{resource_name_prefix}/{full_id}",
          "displayName": entry.display_name,
          "description": entry.description,
      },
      "aspects": {
          "dataplex-types.global.generic": {
              "type": "knowledge-base",
              "system": "enrichment-agent",
          },
      },
  }
  with open(yaml_path, "w") as f:
    yaml.safe_dump(entry_yaml, f, sort_keys=False, allow_unicode=True)
  with open(overview_path, "w") as f:
    f.write(common.clean_overview_body(body) + "\n")
  print(f"[Agent] ✅ {full_id}", flush=True)

  # Per-entry state for multi-turn refinement. A refinement overwrites only the
  # overview sidecar (the entry YAML is unchanged by a content refinement).
  # entry_id is the path-qualified id so session keys are unique and match the
  # on-disk `name:`.
  entry_state = refine.EntryState(
      entry_id=full_id,
      display_name=entry.display_name,
      description=entry.description,
      category_id=top_category,
      grounding_prompt=user_prompt,
      writer_model=_LIGHT_MODEL_FOR_WRITER,
      overview_body=body,
      overview_path=overview_path,
      kind="kb",
  )
  return body, entry_state


def _yaml_path_for(overview_path: str) -> str | None:
  """The entry `.yaml` next to an `.overview.md` sidecar.

  Entry ids are path-qualified (e.g. `a/m`), so reconstructing the yaml path
  from `category_dir + entry_id` would double the folder (`catalog/a/a/m.yaml`).
  The sidecar path already encodes the true on-disk location, so swap its
  extension instead.
  """
  if overview_path and overview_path.endswith(".overview.md"):
    return overview_path[: -len(".overview.md")] + ".yaml"
  return None


def _leaf_id(entry_id: str, category_id: str) -> str:
  """Strip the leading `<category>/` from a path-qualified id (`a/m` -> `m`)."""
  prefix = f"{category_id}/"
  if entry_id.startswith(prefix):
    return entry_id[len(prefix) :]
  return entry_id.split("/")[-1]


def _delete_doc_entry_files(es) -> None:
  """Delete a doc entry's `.yaml` + `.overview.md` from disk (best-effort).

  Only touches local mdcode under output_dir — never live Dataplex content.
  """
  overview_path = es.overview_path
  if not overview_path:
    return
  yaml_path = _yaml_path_for(overview_path)
  for p in (overview_path, yaml_path):
    try:
      if p and os.path.exists(p):
        os.remove(p)
    except OSError:
      pass


def _recategorize_doc_entry(
    es, new_cat, output_dir: str, resource_name_prefix: str = ""
) -> None:
  """Move a kept doc entry's files into the new category dir; update YAML + state.

  Doc-mode layout is `catalog/{category}/{entry}.{yaml,overview.md}` with a
  path-qualified id (`<category>/<entry>`), so a category change is BOTH a file
  move AND a rename of the id/name/resource (the category is encoded in the id).
  The overview body (and any prior refinement edits) is preserved — only the
  location and the id-bearing YAML fields change. `resource.parent` is left to
  the index pass (_build_index_hierarchy), which re-derives it from the new
  location.
  """
  old_overview = es.overview_path
  if not old_overview:
    return
  old_yaml = _yaml_path_for(old_overview)
  leaf = _leaf_id(es.entry_id, es.category_id)
  new_full_id = f"{new_cat.id}/{leaf}"
  new_dir = os.path.join(output_dir, "catalog", new_cat.id)
  new_overview = os.path.join(new_dir, f"{leaf}.overview.md")
  new_yaml = os.path.join(new_dir, f"{leaf}.yaml")
  os.makedirs(os.path.dirname(new_overview), exist_ok=True)
  # Move the overview sidecar.
  try:
    if os.path.exists(old_overview) and old_overview != new_overview:
      os.replace(old_overview, new_overview)
  except OSError:
    pass
  # Move the entry YAML and update its id-bearing fields.
  data = {}
  if old_yaml and os.path.exists(old_yaml):
    try:
      with open(old_yaml) as f:
        data = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
      data = {}
  data["name"] = new_full_id
  data["id"] = new_full_id
  data["category"] = new_cat.id
  resource = data.get("resource") or {}
  if resource_name_prefix:
    resource["name"] = f"{resource_name_prefix}/{new_full_id}"
  data["resource"] = resource
  try:
    os.makedirs(os.path.dirname(new_yaml), exist_ok=True)
    with open(new_yaml, "w") as f:
      yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
    if old_yaml and os.path.exists(old_yaml) and old_yaml != new_yaml:
      os.remove(old_yaml)
  except OSError:
    pass
  es.category_id = new_cat.id
  es.entry_id = new_full_id
  es.overview_path = new_overview


async def apply_reenumeration(session, new_enum, removed_ids) -> None:
  """Materialize a doc-mode re-enumeration delta (add / remove / recategorize).

  Called by refine._reenumerate after the EnumerationAgent produced a new
  categorized entry list from session.enum_context (the original compiled
  summary — so nothing is re-read). New entries are written via
  _write_one_kb_entry, re-categorized entries are moved, and removed entries'
  local files are deleted. Kept entries' overviews + refinement history are
  preserved untouched. Mutates `session.entries` in place.
  """
  output_dir = session.output_dir
  wp = session.writer_params or {}
  entry_type = wp.get("entry_type", _GENERIC_ENTRY_TYPE)
  resource_name_prefix = wp.get("resource_name_prefix", "")
  eg_full_name = wp.get("eg_full_name", "")
  feedback_block = wp.get("feedback_block_global", "")
  removed_ids = set(removed_ids or [])

  # Map each enumerated entry to its PATH-QUALIFIED id. Kept seeds come back from
  # the enumerator with the exact (already-qualified) id we seeded
  # (refine._reenumerate seeds `e.entry_id`); newly discovered entries carry a
  # bare leaf id, so qualify them with their category. session.entries is keyed
  # by the path-qualified id, so all comparisons below use the qualified form.
  new_items = []  # (full_id, entry, cat, is_existing)
  for cat in new_enum.categories:
    for e in cat.entries:
      if e.id in session.entries:
        new_items.append((e.id, e, cat, True))
      else:
        # Mirror _write_one_kb_entry: a bare leaf id gets category-qualified;
        # an already-qualified id is kept as-is.
        full = e.id if "/" in e.id else f"{cat.id}/{e.id}"
        new_items.append((full, e, cat, False))
  new_full_ids = {fid for (fid, *_rest) in new_items}
  old_ids = set(session.entries)
  # Drop anything no longer enumerated, plus anything the user explicitly asked
  # to remove (so a re-add by the enumerator from the same context is ignored).
  to_remove = (old_ids - new_full_ids) | removed_ids
  for eid in sorted(to_remove):
    es = session.entries.get(eid)
    if es is None:
      continue
    _delete_doc_entry_files(es)
    session.entries.pop(eid, None)
    print(f"[refine] 🗑️  removed entry: {eid}", flush=True)

  # Additions + recategorizations.
  sem = asyncio.Semaphore(max(CONCURRENCY_LIMIT, 24))
  add_tasks = []
  for full_id, entry, cat, is_existing in new_items:
    if full_id in removed_ids:
      continue
    if not is_existing:
      # _write_one_kb_entry derives the same `f"{cat.id}/{entry.id}"` id.
      add_tasks.append(
          _write_one_kb_entry(
              entry,
              cat,
              session.topic,
              session.enum_context,
              output_dir,
              entry_type,
              resource_name_prefix,
              sem,
              session.model,
              session.usage_acc,
              existing_overview="",
              feedback_block=feedback_block,
          )
      )
    elif session.entries[full_id].category_id != cat.id:
      es = session.entries[full_id]
      _recategorize_doc_entry(es, cat, output_dir, resource_name_prefix)
      # The id is path-qualified, so a category change renames it — re-key.
      session.entries.pop(full_id, None)
      session.entries[es.entry_id] = es
      print(f"[refine] 🔀 recategorized {full_id} -> {es.entry_id}", flush=True)

  if add_tasks:
    for _body, es in await asyncio.gather(*add_tasks):
      if es is not None:
        session.entries[es.entry_id] = es
        print(f"[refine] ➕ added entry: {es.entry_id}", flush=True)

  # Rebuild the folder index entries + parent/child links from the new on-disk
  # tree (handles adds / removes / recategorizations in one pass).
  dir_meta = {
      cat.id: (cat.title, cat.description) for cat in new_enum.categories
  }
  _build_index_hierarchy(
      output_dir,
      eg_full_name,
      entry_type,
      resource_name_prefix,
      session.topic,
      dir_meta,
  )


# Flash for the writer step: per-entry inputs are small (one entry's slice of
# context, typically <20K tokens) so the ADK 32K Flash routing trap doesn't bite.
_LIGHT_MODEL_FOR_WRITER = os.environ.get("KC_LIGHT_MODEL", "gemini-2.5-flash")
