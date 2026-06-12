"""Doc mode: recursive depth-crawl of Google Docs → map-reduce summarize →

LLM-emitted knowledge-base mdcode. Ported from the former doc_agent_runner.
"""

import asyncio
import glob
import os
import re
import time
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
from tools import github_tools
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


def _partition_doc_inputs(docs: list[str], folders: list[str] | None):
  """Route each --docs/--folder entry to Drive vs local markdown by format.

  Both flags are mixed, comma-separated lists routed per entry (see
  drive_tools.is_local_path, which is format-first):
    --docs:   a Drive Doc URL/ID -> drive_docs; a local .md file -> depth-0
              spine; a local directory -> depth-1 children.
    --folder: a Drive folder URL/ID -> drive_folders; a local directory (or
              file) -> depth-1 children.
  Returns (drive_docs, drive_folders, local_spine_md, local_child_md).
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
):
  _t0 = time.monotonic()
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
  eg_project, eg_location, _eg_id = eg_parts
  entry_type = _GENERIC_ENTRY_TYPE
  resource_name_prefix = (
      f"projects/{eg_project}/locations/{eg_location}/catalog"
  )

  # Scaffold the manifest up front with `kcmd init --entry-group` AND pull any
  # pre-existing entries from KC. The pulled entries become seed inputs to
  # the EnumerationAgent (so they MUST appear in the output even if there's
  # little new content to enrich them), and their existing overview is fed
  # to the per-entry writer as additional grounding context — see
  # _write_one_kb_entry.
  existing_kb_entries = []
  if output_dir:
    ok, msg = kcmd_tools.init_pull_entry_group(
        output_dir, entry_group, entry_type
    )
    print(
        f"[kcmd] init+pull --entry-group {entry_group}:"
        f" {'OK' if ok else 'FAILED'} {msg}",
        flush=True,
    )
    existing_kb_entries = kcmd_tools.list_kb_entries(output_dir)
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
    # on push).
    for _e in existing_kb_entries:
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

  # Route --docs/--folder per entry: Drive inputs vs local markdown (a local .md
  # via --docs is a depth-0 spine; a local dir via --docs/--folder is depth-1
  # children). Local files are injected after the crawl so they never hit Drive.
  start_docs, drive_folders, local_spine_md, local_child_md = (
      _partition_doc_inputs(start_docs, folders))
  if local_spine_md or local_child_md:
    print(f"[Local] 📂 Markdown inputs: {len(local_spine_md)} spine file(s), "
          f"{len(local_child_md)} folder child(ren). Relative paths resolve "
          f"from CWD: {os.getcwd()}", flush=True)

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
  # at depth 1 — exactly mirroring --docs / --folder for Google Docs.
  for p in local_spine_md:
    all_fetched_docs.append((p, 0, read_local_md(p)))
  for p in local_child_md:
    all_fetched_docs.append((p, 1, read_local_md(p)))
  if local_spine_md or local_child_md:
    print(f"[Local] 📄 Injected {len(local_spine_md) + len(local_child_md)} "
          f"local markdown file(s): {len(local_spine_md)} spine, "
          f"{len(local_child_md)} folder child(ren).", flush=True)

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
  ] + code_seed_entries
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

  # Trajectory persists: per-doc fetches (the "tools" of doc mode) plus the
  # enumerated entry list so eval can ground scoring in BOTH what was read and
  # what was emitted.
  # Local markdown inputs are read off disk (read_local_md), not fetched from
  # Drive (fetch_gdoc); label each tool use by its actual source so eval counts
  # them correctly instead of attributing local files to fetch_gdoc.
  tool_uses = [
      {"name": "read_local_md" if is_local_path(url) else "fetch_gdoc",
       "args": {"url": url, "depth": depth}}
      for (url, depth, _content) in all_fetched_docs
  ]
  tool_responses = [
      {"name": "read_local_md" if is_local_path(url) else "fetch_gdoc",
       "response": {"url": url, "depth": depth, "content": content[:50000]}}
      for (url, depth, content) in all_fetched_docs
  ]
  for c in code_cards:
    tool_uses.append({"name": "explore_repo", "args": {"component": c["name"]}})
    tool_responses.append({
        "name": "explore_repo",
        "response": {"url": c["url"], "content": c["content"]},
    })
  tool_uses.append({"name": "enumerate", "args": {"topic": topic}})
  tool_responses.append(
      {"name": "enumerate", "response": enumeration.model_dump()}
  )
  final_text = "\n\n".join(t for t in all_overviews if t)
  common.write_trajectory(
      output_dir,
      "doc",
      f"TOPIC: {topic}",
      tool_uses,
      tool_responses,
      final_text,
      usage_acc,
      latency=time.monotonic() - _t0,
  )
  from tools.drive_tools import get_cache_stats

  print(f"[Cache] doc-fetch stats: {get_cache_stats()}", flush=True)

  # Build the refinement session (consumed by agent_runner --interactive).
  return refine.EnrichmentSession(
      mode="doc",
      topic=topic,
      model=model,
      output_dir=output_dir or "",
      entries={es.entry_id: es for es in entry_states},
      usage_acc=usage_acc,
      # Phase-2 state so a `reenumerate` refinement can re-run enumeration over
      # the same compiled context and write/move/delete entries without
      # re-reading any source docs (see refine._reenumerate -> apply_reenumeration).
      enum_context=compiled_summary,
      writer_params={
          "entry_type": entry_type,
          "resource_name_prefix": resource_name_prefix,
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
  cat_dir = os.path.join(output_dir, "catalog", category.id)
  os.makedirs(cat_dir, exist_ok=True)
  # YAML: deterministic, no LLM. Includes the required `generic` aspect and a
  # `category:` field so downstream consumers can group by it.
  # `name:` is the LOCAL name (just the entry id). kcmd's entrygroup source
  # source.serviceName() prepends `<eg-path>/entries/` to produce the full
  # Dataplex resource path at push time — see toolbox/mdcode/src/libts/
  # sources/entrygroup.ts line 48-50. Setting `name:` to the full path here
  # causes a double-prefix at push.
  entry_yaml = {
      "name": entry.id,
      "id": entry.id,
      "type": entry_type,
      "category": category.id,
      "resource": {
          "name": f"{resource_name_prefix}/{entry.id}",
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
  yaml_path = os.path.join(cat_dir, f"{entry.id}.yaml")
  with open(yaml_path, "w") as f:
    yaml.safe_dump(entry_yaml, f, sort_keys=False, allow_unicode=True)
  overview_path = os.path.join(cat_dir, f"{entry.id}.overview.md")
  with open(overview_path, "w") as f:
    f.write(common.clean_overview_body(body) + "\n")
  print(f"[Agent] ✅ {category.id}/{entry.id}", flush=True)

  # Per-entry state for multi-turn refinement. A refinement overwrites only the
  # overview sidecar (the entry YAML is unchanged by a content refinement).
  entry_state = refine.EntryState(
      entry_id=entry.id,
      display_name=entry.display_name,
      description=entry.description,
      category_id=category.id,
      grounding_prompt=user_prompt,
      writer_model=_LIGHT_MODEL_FOR_WRITER,
      overview_body=body,
      overview_path=overview_path,
      kind="kb",
  )
  return body, entry_state


def _delete_doc_entry_files(es) -> None:
  """Delete a doc entry's `.yaml` + `.overview.md` from disk (best-effort).

  Only touches local mdcode under output_dir — never live Dataplex content.
  """
  overview_path = es.overview_path
  if not overview_path:
    return
  cat_dir = os.path.dirname(overview_path)
  yaml_path = os.path.join(cat_dir, f"{es.entry_id}.yaml")
  for p in (overview_path, yaml_path):
    try:
      if os.path.exists(p):
        os.remove(p)
    except OSError:
      pass


def _recategorize_doc_entry(es, new_cat, output_dir: str) -> None:
  """Move a kept doc entry's files into the new category dir; update YAML + state.

  Doc-mode layout is `catalog/{category}/{entry}.{yaml,overview.md}`, so a
  category change is a file move. The overview body (and any prior refinement
  edits) is preserved — only its location and the YAML `category:` field change.
  """
  old_overview = es.overview_path
  old_dir = os.path.dirname(old_overview) if old_overview else None
  new_dir = os.path.join(output_dir, "catalog", new_cat.id)
  os.makedirs(new_dir, exist_ok=True)
  new_overview = os.path.join(new_dir, f"{es.entry_id}.overview.md")
  # Move the overview sidecar.
  try:
    if (
        old_overview
        and os.path.exists(old_overview)
        and old_overview != new_overview
    ):
      os.replace(old_overview, new_overview)
  except OSError:
    pass
  # Move the entry YAML and update its `category:` field.
  old_yaml = os.path.join(old_dir, f"{es.entry_id}.yaml") if old_dir else None
  new_yaml = os.path.join(new_dir, f"{es.entry_id}.yaml")
  data = {}
  if old_yaml and os.path.exists(old_yaml):
    try:
      with open(old_yaml) as f:
        data = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
      data = {}
  data["category"] = new_cat.id
  try:
    with open(new_yaml, "w") as f:
      yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
    if old_yaml and os.path.exists(old_yaml) and old_yaml != new_yaml:
      os.remove(old_yaml)
  except OSError:
    pass
  es.category_id = new_cat.id
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
  feedback_block = wp.get("feedback_block_global", "")
  removed_ids = set(removed_ids or [])

  new_by_id = {
      e.id: (e, cat) for cat in new_enum.categories for e in cat.entries
  }
  old_ids = set(session.entries)
  # Drop anything no longer enumerated, plus anything the user explicitly asked
  # to remove (so a re-add by the enumerator from the same context is ignored).
  to_remove = (old_ids - set(new_by_id)) | removed_ids
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
  for eid, (entry, cat) in new_by_id.items():
    if eid in removed_ids:
      continue
    if eid not in session.entries:
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
    elif session.entries[eid].category_id != cat.id:
      _recategorize_doc_entry(session.entries[eid], cat, output_dir)
      print(f"[refine] 🔀 recategorized {eid} -> {cat.id}", flush=True)

  if add_tasks:
    for _body, es in await asyncio.gather(*add_tasks):
      if es is not None:
        session.entries[es.entry_id] = es
        print(
            f"[refine] ➕ added entry: {es.category_id}/{es.entry_id}",
            flush=True,
        )


# Flash for the writer step: per-entry inputs are small (one entry's slice of
# context, typically <20K tokens) so the ADK 32K Flash routing trap doesn't bite.
_LIGHT_MODEL_FOR_WRITER = "gemini-3.5-flash"
