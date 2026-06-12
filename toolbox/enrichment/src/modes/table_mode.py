"""Table mode: Dataplex-sourced, folder-grounded BigQuery table enrichment.

Discovers a BigQuery dataset's tables via the Dataplex Catalog, then for EACH table
routes only the relevant Drive-folder documents to it (via an LLM relevance router)
and enriches it with Metadata-as-Code (an entry YAML + an overview sidecar) grounded
in those documents. Tables with no relevant docs get a schema-only overview. Output
is scoped to the dataset's real `@bigquery` entry group so the overview can land on
the live Dataplex entries. Ported from the former table_agent_runner.
"""

import asyncio
import json
import os
import re
import time

import yaml

import common
from engine import (
    create_doc_summarizer_runner,
    create_router_runner,
    create_table_overview_runner,
)
from tools import kcmd_tools
from tools.drive_tools import list_folder_files, fetch_doc_text, extract_folder_id, is_local_path, list_local_md, read_local_md

# kcmd's canonical entry type for BigQuery tables under a bq-dataset scope.
_BQ_TABLE_TYPE = "dataplex-types.global.bigquery-table"

CONCURRENCY_LIMIT = 4       # parallel LLM calls (doc summaries, routing, per-table gen)
RELEVANCE_THRESHOLD = 0.5    # min router score for a doc to feed a table
MAX_DOC_CHARS = 30000        # per-doc content budget when building a table's focused context


def _parse_dataset(dataset: str) -> tuple[str, str]:
    """`project.dataset` -> (project, dataset). The project must be explicit."""
    dataset = (dataset or "").strip()
    if "." not in dataset:
        raise ValueError(
            f"--dataset must be fully qualified as `project.dataset` (got '{dataset}').")
    project, ds = dataset.split(".", 1)
    return project, ds


def _write_table_files(output_dir: str, project: str, dataset_id: str, meta: dict, overview_body: str) -> list[str]:
    """Add the enriched overview sidecar next to the table entry that
    `kcmd init --pull` already wrote. We do NOT rewrite the entry YAML — the
    pulled entry (with its 1P schema/storage aspects) is the source of truth; we
    only contribute the `overview` aspect via a `<table>.overview.md` sidecar
    (md-sidecar support), and publish only that aspect."""
    if not output_dir:
        return []
    table = meta["table"]
    rel_dir = os.path.join("catalog", f"{project}.{dataset_id}")
    abs_dir = os.path.join(output_dir, rel_dir)
    os.makedirs(abs_dir, exist_ok=True)

    # If the pull somehow didn't produce the entry, write a minimal one so push
    # still has a target.
    entry_path = os.path.join(abs_dir, f"{table}.yaml")
    if not os.path.exists(entry_path):
        resource = {"name": f"projects/{project}/datasets/{dataset_id}/tables/{table}",
                    "displayName": table}
        if meta.get("description"):
            resource["description"] = meta["description"]
        with open(entry_path, "w") as f:
            yaml.safe_dump({"name": f"{project}.{dataset_id}/{table}",
                            "type": _BQ_TABLE_TYPE, "resource": resource,
                            "aspects": {}}, f, sort_keys=False, allow_unicode=True)

    # Overview sidecar — pure Markdown body, NO frontmatter. kcmd merges any
    # sidecar frontmatter straight into the aspect payload (standard layout), and
    # the live `dataplex-types.global.overview` aspectType only accepts
    # content/contentType — emitting e.g. `userManaged` makes `kcmd push` fail
    # with "Unknown property". contentType=MARKDOWN is inferred from the
    # `.overview` suffix on load, so no frontmatter is needed.
    overview_path = os.path.join(abs_dir, f"{table}.overview.md")
    with open(overview_path, "w") as f:
        f.write(common.clean_overview_body(overview_body) + "\n")

    return [os.path.join(rel_dir, f"{table}.overview.md")]


async def _prepare_docs(topic: str, folder_id: str | None, usage_acc: dict, model: str) -> list[dict]:
    """Fetch folder docs and summarize each into a compact router descriptor.

    Returns a list of {id, name, url, content, descriptor}.
    """
    if not folder_id:
        return []

    # A local markdown file or directory grounds table overviews from disk (no
    # Drive). Mirrors the Drive-folder path; descriptors are summarized the same.
    if is_local_path(folder_id):
        md_paths = list_local_md(folder_id)
        files = [{"id": p, "name": os.path.basename(p), "webViewLink": p,
                  "mimeType": "text/markdown", "_local": True} for p in md_paths]
        print(f"[Local] 📁 Local markdown grounding: {folder_id} (resolved: "
              f"{os.path.abspath(os.path.expanduser(folder_id))}) -> {len(files)} "
              f"file(s). Reading + summarizing...", flush=True)
    else:
        print(f"[Folder] 📁 Listing Drive folder: {folder_id}", flush=True)
        files = list_folder_files(folder_id)
        print(f"[Folder] 📁 Found {len(files)} file(s). Fetching + summarizing...", flush=True)

    sem = asyncio.Semaphore(CONCURRENCY_LIMIT)

    async def _prep(idx, f):
        fid = f.get("id")
        url = f.get("webViewLink") or fid
        name = f.get("name", "")
        if f.get("_local"):
            content = await asyncio.to_thread(read_local_md, fid)
        else:
            content = await asyncio.to_thread(fetch_doc_text, fid, f.get("mimeType", ""))
        async with sem:
            prompt = f"DOCUMENT TITLE: {name}\nSOURCE URL: {url}\n\nDOCUMENT CONTENT:\n{content[:50000]}"
            descriptor = await common.run_text(create_doc_summarizer_runner(model), prompt, usage_acc)
        return {"id": idx, "name": name, "url": url, "content": content, "descriptor": descriptor.strip()}

    docs = await asyncio.gather(*[_prep(i, f) for i, f in enumerate(f for f in files if f.get("id"))])
    return list(docs)


def _parse_router(text: str, n_docs: int) -> list[tuple[int, float]]:
    """Parse the router's JSON array into [(doc_index, score)] above threshold."""
    t = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        t = m.group(1).strip()
    if not t.startswith("["):
        m = re.search(r"\[.*\]", t, re.S)
        t = m.group(0) if m else "[]"
    try:
        arr = json.loads(t)
    except (ValueError, json.JSONDecodeError):
        return []
    out = []
    for o in arr if isinstance(arr, list) else []:
        try:
            idx = int(o["doc"])
            score = float(o.get("score", 0))
        except (KeyError, ValueError, TypeError):
            continue
        if 0 <= idx < n_docs and score >= RELEVANCE_THRESHOLD:
            out.append((idx, score))
    return sorted(out, key=lambda x: -x[1])


async def _route_docs_for_table(table_meta: dict, docs: list[dict], usage_acc: dict, model: str) -> list[tuple[int, float]]:
    """Ask the router which docs are relevant to this table; return [(idx, score)]."""
    if not docs:
        return []
    table_block = kcmd_tools.flatten_table_for_prompt(table_meta, max_fields=80)
    catalog = "\n\n".join(f"[{d['id']}] {d['descriptor']}" for d in docs)
    prompt = (
        f"TARGET TABLE:\n{table_block}\n\n"
        f"CANDIDATE DOCUMENTS (numbered):\n{catalog}\n\n"
        f"Return the JSON array of relevant documents for THIS table."
    )
    text = await common.run_text(create_router_runner(model), prompt, usage_acc)
    return _parse_router(text, len(docs))


async def run(dataset: str, folder: str | None, topic: str, output_dir: str | None, model: str):
    _t0 = time.monotonic()
    project, dataset_id = _parse_dataset(dataset)
    # Accept either a bare folder id or a full Drive folder URL.
    folder = extract_folder_id(folder) if folder else folder

    print("=" * 60)
    print("=== ADK TABLE AGENT: Dataplex-Sourced, Folder-Grounded Enrichment ===")
    print(f"Topic: {topic}")
    print(f"Dataset: {project}.{dataset_id}  |  Folder: {folder or '(none)'}")
    print("=" * 60)

    usage_acc = {"input": 0, "output": 0}
    if not output_dir:
        print("[kcmd] ❌ output_dir is required (kcmd writes the snapshot there).", flush=True)
        return

    # 1. Discover tables via kcmd — NO direct Dataplex API. Runs `kcmd init
    #    --bigquery-dataset <proj>.<dataset>`, writes a schema-declaring manifest,
    #    then `kcmd pull` -> catalog/<proj>.<dataset>/<table>.yaml with schema.
    #    (kcmd_tools echoes each real command it runs.)
    print(f"[kcmd] 🔎 Discovering {project}.{dataset_id} via kcmd init + pull ...", flush=True)
    ok, msg = await asyncio.to_thread(
        kcmd_tools.init_pull_dataset, output_dir, project, dataset_id)
    print(f"[kcmd] {'OK' if ok else '⚠️  FAILED'}: {msg}", flush=True)

    table_names = kcmd_tools.list_tables(output_dir, project, dataset_id)
    tables = [kcmd_tools.read_table_meta(output_dir, project, dataset_id, t)
              for t in table_names]
    for meta in tables:
        print(f"[kcmd] 📑 {meta['table']} ({len(meta['schema_fields'])} cols)", flush=True)

    if not tables:
        print("[kcmd] ❌ No table entries pulled — nothing to enrich. "
              "Check the dataset id and that you can read its @bigquery entries.", flush=True)
        return

    # 2. Fetch + summarize the Drive folder into per-doc router descriptors.
    docs = await _prepare_docs(topic, folder, usage_acc, model)
    if not docs:
        print("[Folder] ⚠️  No folder content — tables will be documented from schema only.", flush=True)

    # 3. For each table: route only its relevant docs, then enrich. Parallel.
    print(f"\n[Agent] 🏗️  Routing + enriching {len(tables)} table(s)...", flush=True)
    sem = asyncio.Semaphore(CONCURRENCY_LIMIT)

    async def _enrich(meta):
        async with sem:
            selected = await _route_docs_for_table(meta, docs, usage_acc, model)
            sel_docs = [docs[i] for (i, _s) in selected]
            label = ", ".join(f"{docs[i]['name']} ({s:.2f})" for (i, s) in selected) or "(none — schema-only)"
            print(f"[Router] {meta['table']} ← {label}", flush=True)

            if sel_docs:
                context = "\n\n".join(
                    f"--- DOCUMENT: {d['name']} ({d['url']}) ---\n{d['content'][:MAX_DOC_CHARS]}"
                    for d in sel_docs
                )
            else:
                context = ""

            table_block = kcmd_tools.flatten_table_for_prompt(meta)
            prompt = (
                f"TOPIC: {topic}\n\n"
                f"RELEVANT CONTEXT DOCUMENTS (only docs routed to this table):\n"
                f"{context or '(none — document this table from its schema/metadata only)'}\n\n"
                f"TARGET TABLE METADATA (from kcmd snapshot):\n{table_block}\n\n"
                f"Write the overview for this table now."
            )
            overview_body = await common.run_text(create_table_overview_runner(model), prompt, usage_acc)
            written = _write_table_files(output_dir, project, dataset_id, meta, overview_body)
            print(f"[Agent] ✅ {meta['table']}: wrote {', '.join(written) or '(skipped — no output_dir)'}", flush=True)
            return meta, [docs[i] for (i, _s) in selected], overview_body

    results = await asyncio.gather(*[_enrich(m) for m in tables])

    # 4. catalog.yaml was already written by kcmd_tools.init_pull_dataset (scope +
    #    snapshot declaring schema + publishing only the overview aspect).

    # 5. Persist trajectory for dynamic eval (mirrors doc mode). For each table we
    # record the routed (relevant) docs, so eval can see the grounding.
    if output_dir:
        tool_uses = [{"name": "get_table_entry", "args": {"table": m["table"]}} for m in tables]
        tool_responses = [
            {"name": "get_table_entry",
             "response": {"table": m["table"], "schema_fields": m["schema_fields"]}}
            for m in tables
        ]
        for (meta, sel_docs, _text) in results:
            tool_uses.append({"name": "route_docs", "args": {"table": meta["table"]}})
            tool_responses.append({
                "name": "route_docs",
                "response": {
                    "table": meta["table"],
                    "relevant_docs": [
                        {"name": d["name"], "url": d["url"], "content": d["content"][:50000]}
                        for d in sel_docs
                    ],
                },
            })
        final_text = "\n\n".join(t for (_m, _d, t) in results)
        common.write_trajectory(
            output_dir, "table",
            f"TOPIC: {topic} | DATASET: {project}.{dataset_id}",
            tool_uses, tool_responses, final_text, usage_acc,
            latency=time.monotonic() - _t0)
