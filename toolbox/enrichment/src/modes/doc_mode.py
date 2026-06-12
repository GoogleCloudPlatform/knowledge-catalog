"""Doc mode: recursive depth-crawl of Google Docs → map-reduce summarize →
LLM-emitted knowledge-base mdcode. Ported from the former doc_agent_runner.
"""

import asyncio
import glob
import os
import re
import time
import uuid

import yaml
from google.genai import types

import common
from engine import create_summarizer_runner, create_mdcode_runner
from tools import kcmd_tools
from tools.drive_tools import (
    fetch_doc_text,
    extract_gdoc_id,
    extract_folder_id,
    list_folder_files,
)

MAX_BATCH_SIZE = 10
MAX_DEPTH = 3
CONCURRENCY_LIMIT = 4

# The 1P "generic" entry type that all knowledge-base entries are created as
# (cloud/dataplex/catalog/types/entry-types/generic.textproto -> the global
# Dataplex type). The enriched content lands as the `overview` aspect on these
# entries. This is fixed -- there is no per-run entry-type choice.
_GENERIC_ENTRY_TYPE = "dataplex-types.global.generic"


async def _fetch_url(url: str, depth: int, mime_type: str = ""):
    print(f"[Crawler] 📥 Fetching (Depth {depth}): {url}", flush=True)
    content = await asyncio.to_thread(fetch_doc_text, url, mime_type)
    return url, depth, content


async def _summarize_batch(topic: str, master_scope_text: str, batch_docs: list, sem: asyncio.Semaphore, model: str, usage_acc: dict | None = None) -> str:
    async with sem:
        runner = create_summarizer_runner(model)
        user_id = str(uuid.uuid4())
        session = await runner.session_service.create_session(app_name=runner.app_name, user_id=user_id)

        docs_text = ""
        for url, depth, content in batch_docs:
            docs_text += f"\n\n--- DOCUMENT (Depth {depth}): {url} ---\n{content[:50000]}\n"

        prompt = f"TOPIC: {topic}\n\nMASTER SCOPE:\n{master_scope_text}\n\nRAW BATCH DOCUMENTS:\n{docs_text}"

        new_summary = ""
        async for event in runner.run_async(
            user_id=user_id, session_id=session.id,
            new_message=types.Content(role="user", parts=[types.Part.from_text(text=prompt)])
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
        f'Treat "{topic}" as the single overarching project for this knowledge'
        " base. The following source documents were collected from a Google"
        " Drive folder. Group all extracted findings into coherent sub-topics"
        " under this project; do not treat each source file as its own"
        " top-level project.",
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
            name = entry.get("id") or os.path.basename(yaml_path)[:-len(".yaml")]
            entry = {"name": name, **entry}  # name first; keep other fields
            changed = True
        aspects = entry.get("aspects") or {}
        if not any(isinstance(k, str) and k.split(".")[-1] == "generic" for k in aspects):
            aspects["dataplex-types.global.generic"] = {
                "type": "knowledge-base", "system": "enrichment-agent"}
            entry["aspects"] = aspects
            changed = True
        if changed:
            with open(yaml_path, "w") as f:
                yaml.safe_dump(entry, f, sort_keys=False, allow_unicode=True)
            fixed.append(os.path.join("catalog", os.path.basename(yaml_path)))
    return fixed


async def run(topic: str, docs: list[str], folder: str | None, output_dir: str | None,
              model: str, entry_group: str):
    _t0 = time.monotonic()
    # entry_group is `project.location.entryGroupId`; derive the resource-name
    # prefix for the generated KB entries. All entries use the 1P generic entry
    # type (no per-run choice); the enriched content is their `overview` aspect.
    eg_parts = entry_group.split(".")
    if len(eg_parts) != 3:
        raise ValueError(
            f"--entry-group must be `project.location.entryGroupId` (got '{entry_group}').")
    eg_project, eg_location, _eg_id = eg_parts
    entry_type = _GENERIC_ENTRY_TYPE
    resource_name_prefix = f"projects/{eg_project}/locations/{eg_location}/catalog"

    # Scaffold the manifest up front with `kcmd init --entry-group` (clean output
    # dir), so the agent talks to the catalog only through kcmd. A normal entry
    # group uses the STANDARD layout, so the LLM's generated `<id>.yaml` +
    # `<id>.overview.md` files are consumed directly. The LLM then generates ONLY
    # the entries.
    if output_dir:
        ok, msg = kcmd_tools.init_entry_group(output_dir, entry_group, entry_type)
        print(f"[kcmd] init --entry-group {entry_group}: {'OK' if ok else 'FAILED'} {msg}", flush=True)

    # Maps a file id/url to its known Drive mimeType (empty = treat as a Google
    # Doc and let fetch_doc_text dispatch). Crawled gdoc links default to "".
    mime_by_id = {}
    start_docs = list(docs or [])     # explicit --docs: authoritative depth-0 spine
    folder_seed_urls = []             # folder files: injected as depth-1 children
    folder_files = []

    folder = extract_folder_id(folder) if folder else folder

    # Seed additional inputs by listing a Drive folder (Docs, Sheets, Slides, PDFs).
    if folder:
        print(f"[Crawler] 📁 Listing Drive folder: {folder}", flush=True)
        folder_files = list_folder_files(folder)
        print(f"[Crawler] 📁 Found {len(folder_files)} file(s) in folder.", flush=True)
        for f in folder_files:
            fid = f.get("id")
            if not fid:
                continue
            mime_by_id[fid] = f.get("mimeType", "")
            folder_seed_urls.append(fid)

    # When seeding purely from a folder there is no authoritative document to be
    # the Master Scope, so synthesize one and treat the folder files as its
    # depth-1 children. If explicit --docs were given, those remain the spine.
    synthetic_scope_text = ""
    if folder_seed_urls and not start_docs:
        synthetic_scope_text = _build_synthetic_scope(topic, folder_files)

    print("=" * 60)
    print(f"=== ADK DOC AGENT: Parallel Depth-Weighted Knowledge Base Enrichment ===")
    print(f"Topic: {topic}")
    print(f"Start Docs: {len(start_docs)} | Folder files (depth 1): {len(folder_seed_urls)}")
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
                fetch_tasks.append(_fetch_url(url, depth, mime_by_id.get(doc_id, mime_by_id.get(url, ""))))

        results = await asyncio.gather(*fetch_tasks) if fetch_tasks else []
        all_fetched_docs.extend(results)

        next_level_urls = set()
        if depth < MAX_DEPTH:
            for url, d, content in results:
                links = set(re.findall(r"https://docs\.google\.com/document/d/[a-zA-Z0-9-_]+", content))
                for link in links:
                    if extract_gdoc_id(link) not in visited_ids:
                        next_level_urls.add(link)
        carried_urls = list(next_level_urls)

    print(f"\n[Crawler] 🏁 Finished fetching {len(all_fetched_docs)} documents total.\n")

    # Extract Depth 0 documents as Master Scope. When seeding from a folder
    # there are no depth-0 docs, so the synthetic scope stands in as the spine.
    master_scope_docs = [doc for doc in all_fetched_docs if doc[1] == 0]
    master_scope_text = synthetic_scope_text
    if master_scope_text:
        master_scope_text += "\n\n"
    for url, depth, content in master_scope_docs:
        master_scope_text += f"--- MASTER SCOPE DOC: {url} ---\n{content[:50000]}\n\n"

    # 2. Parallel Summarize (Map)
    print(f"[Agent] 🧠 Launching Parallel Summarizers (Batches of {MAX_BATCH_SIZE})...", flush=True)
    sem = asyncio.Semaphore(CONCURRENCY_LIMIT)
    summarize_tasks = []
    # Accumulate enrichment-agent token usage across summarizer + reduce phases.
    usage_acc = {"input": 0, "output": 0}

    for i in range(0, len(all_fetched_docs), MAX_BATCH_SIZE):
        batch = all_fetched_docs[i:i + MAX_BATCH_SIZE]
        summarize_tasks.append(_summarize_batch(topic, master_scope_text, batch, sem, model, usage_acc))

    all_summaries = await asyncio.gather(*summarize_tasks)
    print(f"\n[Agent] ✅ Completed {len(all_summaries)} parallel batch summaries.\n")

    # 3. Final Generation (Reduce)
    print("[Agent] 🏗️  Generating final Dataplex mdcode from aggregated summary...", flush=True)
    runner = create_mdcode_runner(model, entry_type, resource_name_prefix)
    user_id = str(uuid.uuid4())
    session = await runner.session_service.create_session(app_name=runner.app_name, user_id=user_id)

    compiled_summary = "\n\n".join([f"--- BATCH SUMMARY {i+1} ---\n{s}" for i, s in enumerate(all_summaries)])
    prompt = f"TOPIC: {topic}\n\nFINAL COMPILED SUMMARY OF ALL BATCHES:\n{compiled_summary}\n\nPlease generate the Dataplex mdcode (YAML and Markdown). Ensure you retain the source document URLs and map them to their corresponding sub-topics. Weight the topics according to their original depth (prioritize Top-Level topics)."

    final_output = ""
    async for event in runner.run_async(
        user_id=user_id, session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part.from_text(text=prompt)])
    ):
        usage = getattr(event, "usage_metadata", None)
        if usage:
            usage_acc["input"] += getattr(usage, "prompt_token_count", 0) or 0
            usage_acc["output"] += getattr(usage, "candidates_token_count", 0) or 0
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.text:
                    final_output += part.text
                    print(part.text, end="", flush=True)

    print("\n")

    # The LLM emits the mdcode entry files as fenced blocks; parse + write them.
    # (catalog.yaml was already scaffolded via `kcmd init --entry-group` at the start.)
    common.parse_mdcode_blocks(final_output, output_dir)

    # Normalize entries for push: backfill `name:` (the STANDARD layout indexes by
    # it; the LLM emits `id:`) and add the required `generic` aspect.
    if output_dir:
        named = _normalize_entries(output_dir)
        print(f"[kcmd] Normalized {len(named)} entr{'y' if len(named)==1 else 'ies'} "
              f"(name + required generic aspect).", flush=True)

    # Persist the captured trajectory. For the doc agent the "tools" are the
    # document fetches; each fetched source doc is recorded as a tool call +
    # response so downstream evaluation can ground scoring in the actual source
    # material the agent read.
    tool_uses = [
        {"name": "fetch_gdoc", "args": {"url": url, "depth": depth}}
        for (url, depth, _content) in all_fetched_docs
    ]
    tool_responses = [
        {"name": "fetch_gdoc",
         "response": {"url": url, "depth": depth, "content": content[:50000]}}
        for (url, depth, content) in all_fetched_docs
    ]
    common.write_trajectory(output_dir, "doc", f"TOPIC: {topic}",
                            tool_uses, tool_responses, final_output, usage_acc,
                            latency=time.monotonic() - _t0)