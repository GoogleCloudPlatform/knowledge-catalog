"""Context-overlay mode: table mode + `kcmd reference`, distinct output.

Mostly identical to table_mode — discover the dataset's tables, fetch + route
the
Drive-folder docs per table, and write a doc-grounded overview per table. Two
deltas only:

  1. Sourcing. The 1P BigQuery table entries are pulled READ-ONLY via
     `kcmd reference` instead of `kcmd init --bigquery-dataset` + `pull`. `kcmd
     reference` writes them straight into the catalog tree as
     `catalog/bigquery/<project>/<dataset>/<table>.ref.yaml` (+ a
     `<table>.ref.overview.md` sidecar when the table has an overview). For each
     table a NEW "context overlay" entry is created in the editable
     `--entry-group` (1 overlay : 1 table); the 1P entry is never touched.

  2. Output format, per table, under `catalog/bigquery/<project>/<dataset>/`:
       <table>.yaml             -- overlay entry (pushable; overlay_id == table)
       <table>.overview.md      -- enriched, doc-grounded overview
       <table>.ref.yaml         -- read-only copy of the 1P table  (by kcmd)
       <table>.ref.overview.md  -- the table's overview, if any     (by kcmd)

This mode writes ONLY the overlay pair; the `.ref.*` mirror is produced by `kcmd
reference`. Only the overlay entry + its overview are pushed (the `.ref.*` are
read-only bigquery-table entries, filtered out of publishing; the webapp also
stages only the selected overlay files).
"""

import asyncio
import os
import time

import common
from engine import (
    OVERLAY_WRITER_INSTRUCTION,
    _light_model,
    create_doc_summarizer_runner,
)
from modes import table_mode
import refine
from tools import bq_usage_tools
from tools import feedback_tools
from tools import github_tools
from tools import kcmd_tools
from tools.drive_tools import extract_gdoc_id, fetch_doc_text
from tools.drive_tools import get_cache_stats, is_local_path, list_local_md, read_local_md
import yaml

# Overlay entries are generic-typed in the editable entry group; the enriched
# content lands in the `overview` aspect (same convention as doc mode).
_OVERLAY_ENTRY_TYPE = "dataplex-types.global.generic"
CONCURRENCY_LIMIT = 12
MAX_DOC_CHARS = 30000


def _parse_eg(entry_group: str) -> tuple[str, str, str]:
  parts = (entry_group or "").split(".")
  if len(parts) != 3 or not all(parts):
    raise ValueError(
        "--entry_group must be `project.location.entryGroupId` (got"
        f" '{entry_group}')."
    )
  return parts[0], parts[1], parts[2]


async def _prepare_explicit_docs(
    doc_urls: list[str], usage_acc: dict, model: str
) -> list[dict]:
  """Fetch + summarize individual Google Doc URLs into router descriptors.

  Companion to `table_mode._prepare_docs` (which handles a Drive folder); used
  so the context-overlay UI's combined "doc URLs OR folder URLs" field works
  either way. Returns {id, name, url, content, descriptor} dicts (ids reassigned
  by caller).
  """
  if not doc_urls:
    return []
  # Expand each entry: a local .md file -> itself; a local directory -> its .md
  # files; anything else -> a Google Doc URL/ID fetched from Drive. So the
  # combined "doc URLs OR folder" field accepts local markdown too.
  sources = []  # (is_local, identifier)
  for u in doc_urls:
    u = (u or "").strip()
    if not u:
      continue
    if is_local_path(u):
      paths = list_local_md(u)
      sources.extend((True, p) for p in paths)
      print(f"[Route] --docs {u!r} -> local markdown ({len(paths)} file(s)).",
            flush=True)
    else:
      sources.append((False, u))
      print(f"[Route] --docs {u!r} -> Drive doc.", flush=True)
  sem = asyncio.Semaphore(CONCURRENCY_LIMIT)

  async def _prep(idx, is_local, ident):
    if is_local:
      content = await asyncio.to_thread(read_local_md, ident)
    else:
      content = await asyncio.to_thread(
          fetch_doc_text, extract_gdoc_id(ident) or ident, ""
      )
    name = os.path.basename(ident) if is_local else ident
    async with sem:
      prompt = (
          f"DOCUMENT TITLE: {name}\nSOURCE URL: {ident}\n\nDOCUMENT"
          f" CONTENT:\n{content[:50000]}"
      )
      descriptor = await common.run_text(
          create_doc_summarizer_runner(model), prompt, usage_acc
      )
    return {
        "id": idx,
        "name": name,
        "url": ident,
        "content": content,
        "descriptor": descriptor.strip(),
        "_kind": "local_md" if is_local else "gdoc",
    }

  return list(
      await asyncio.gather(
          *[_prep(i, isl, idt) for i, (isl, idt) in enumerate(sources)]
      )
  )


async def _prepare_all_docs(
    topic: str,
    folders: list[str] | None,
    doc_urls: list[str] | None,
    usage_acc: dict,
    model: str,
    repo: str = "",
    repo_ref: str = "",
    repo_subdir: str = "",
    mcp_config: str = "",
) -> list[dict]:
  """Build the router-descriptor doc list from folders, explicit docs, and/or a

  GitHub repo.

  `folders` and `doc_urls` are mixed lists routed per entry (Drive vs local
  markdown). The router indexes docs by their `id` == list position, so ids are
  reassigned sequentially after merging the sources. Code component cards (when
  --repo is set) join the pool in the same shape and are routed to tables like
  any other candidate document.
  """
  docs = []
  if folders:
    docs.extend(
        await table_mode._prepare_docs(topic, folders, usage_acc, model))
  if doc_urls:
    docs.extend(await _prepare_explicit_docs(doc_urls, usage_acc, model))
  if repo:
    code_docs = await github_tools.gather_repo_context(
        repo,
        repo_ref,
        repo_subdir,
        topic,
        model,
        usage_acc,
        mcp_config_path=mcp_config or None,
    )
    for d in code_docs:
      d["_kind"] = "code"
    docs.extend(code_docs)
  for i, d in enumerate(docs):
    d["id"] = i
  return docs


def _write_overlay_files(
    output_dir: str,
    eg_project: str,
    eg_location: str,
    eg_id: str,
    ref_project: str,
    ref_dataset: str,
    overlay_id: str,
    table: str,
    meta: dict,
    category_id: str,
    overlay_overview: str,
) -> list[str]:
  """Write the overlay entry alongside its `kcmd reference` source table.

  Returns rel paths. Writes ONLY the pushable overlay pair, into the same source
  subfolder `kcmd reference` already populated with the read-only 1P mirror:
    <table>.yaml         -- overlay entry (pushable)
    <table>.overview.md  -- enriched, doc-grounded overview

  The read-only `<table>.ref.yaml` / `<table>.ref.overview.md` mirror is
  produced
  by `kcmd reference` itself (no longer written here).
  """
  rel_dir = os.path.join("catalog", "bigquery", ref_project, ref_dataset)
  catalog_dir = os.path.join(output_dir, rel_dir)
  os.makedirs(catalog_dir, exist_ok=True)
  written = []

  # --- Overlay entry (pushable) ---
  # kcmd's EntryGroupSource keys the local entry name as
  # `<eg_id>/<eg_project>/<eg_location>/<entryId>` and derives the pushed entry id
  # from `name.split('/').slice(3)` (entrygroup.ts serviceName). The `name:` must
  # use that nested form or the created entry id comes out empty (`.../entries/`).
  local_name = f"{eg_id}/{eg_project}/{eg_location}/{overlay_id}"
  overlay_entry = {
      "name": local_name,
      "id": overlay_id,
      "type": _OVERLAY_ENTRY_TYPE,
      "category": category_id,
      "resource": {
          "displayName": meta.get("display_name") or table,
          "description": (
              meta.get("description") or f"Context overlay for {table}."
          ),
      },
      "aspects": {
          "dataplex-types.global.generic": {
              "type": "context-overlay",
              "system": "enrichment-agent",
          },
      },
  }

  overlay_yaml = os.path.join(catalog_dir, f"{overlay_id}.yaml")
  with open(overlay_yaml, "w") as f:
    yaml.safe_dump(overlay_entry, f, sort_keys=False, allow_unicode=True)
  written.append(os.path.join(rel_dir, f"{overlay_id}.yaml"))

  overlay_md = os.path.join(catalog_dir, f"{overlay_id}.overview.md")
  with open(overlay_md, "w") as f:
    f.write(common.clean_overview_body(overlay_overview) + "\n")
  written.append(os.path.join(rel_dir, f"{overlay_id}.overview.md"))

  return written


async def run(
    dataset: str,
    folders: list[str] | None,
    topic: str,
    output_dir: str | None,
    model: str,
    entry_group: str,
    docs: list[str] | None = None,
    tables_filter: list[str] | None = None,
    include_usage: bool = True,
    usage_window_days: int = 30,
    anonymize_users: bool = False,
    usage_scope: str = "auto",
    feedback_dir: str | None = None,
    feedback_files: list[str] | None = None,
    repo: str = "",
    repo_ref: str = "",
    repo_subdir: str = "",
    mcp_config: str = "",
):
  _t0 = time.monotonic()
  project, dataset_id = table_mode._parse_dataset(dataset)
  eg_project, eg_location, eg_id = _parse_eg(entry_group)
  # --folder is a mixed list (Drive folders and/or local md dirs); each entry is
  # routed and id-extracted per entry inside _prepare_all_docs.
  folders = list(folders or [])
  # Same up-front feedback load as table_mode — proposals route per-table
  # to the overlay's own _write_one below.
  all_feedback = feedback_tools.load_feedback(feedback_dir, feedback_files)

  print("=" * 60)
  print("=== CONTEXT-OVERLAY AGENT: tables + documents ===")
  print(f"Topic: {topic}")
  print(
      f"Dataset: {project}.{dataset_id}  |  Folders: {folders or '(none)'}  | "
      f" Entry group: {entry_group}"
  )
  if all_feedback:
    print(
        f"[Feedback] 📝 Loaded {len(all_feedback)} user-feedback"
        " proposal(s) — these will OVERRIDE conflicting context per overlay.",
        flush=True,
    )
  print("=" * 60)

  if not output_dir:
    print(
        "[kcmd] ❌ output_dir is required (kcmd writes the snapshot there).",
        flush=True,
    )
    return
  usage_acc = {"input": 0, "output": 0}

  # 1. Pull the read-only 1P table entries via `kcmd reference`
  #    (-> catalog/bigquery/<proj>/<dataset>/<table>.ref.yaml).
  print(
      f"[kcmd] 🔎 Referencing {project}.{dataset_id} via kcmd reference ...",
      flush=True,
  )
  ok, msg = await asyncio.to_thread(
      kcmd_tools.init_reference,
      output_dir,
      entry_group,
      project,
      dataset_id,
      _OVERLAY_ENTRY_TYPE,
  )
  print(f"[kcmd] {'OK' if ok else '⚠️  FAILED'}: {msg}", flush=True)

  table_names = kcmd_tools.list_reference_tables(
      output_dir, project, dataset_id
  )
  # Optional filter: enrich only the requested tables (accepts short names or
  # full `project.dataset.table` FQNs). Empty/None = all tables in the dataset.
  if tables_filter:
    wanted = {t.strip().split(".")[-1] for t in tables_filter if t.strip()}
    filtered = [t for t in table_names if t in wanted]
    if filtered:
      table_names = filtered
    else:
      print(
          f"[kcmd] ⚠️  None of --tables {sorted(wanted)} matched pulled tables"
          f" {table_names}; enriching all.",
          flush=True,
      )
  tables = [
      kcmd_tools.read_reference_table_meta(output_dir, project, dataset_id, t)
      for t in table_names
  ]
  for meta in tables:
    print(
        f"[kcmd] 📑 {meta['table']} ({len(meta['schema_fields'])} cols)",
        flush=True,
    )
  if not tables:
    print(
        "[kcmd] ❌ No reference table entries pulled — nothing to enrich. "
        "Check the dataset id and that you can read its @bigquery entries.",
        flush=True,
    )
    return

  # 2. In parallel: fetch + summarize the context docs AND pull BQ
  #    query-history usage signals from INFORMATION_SCHEMA per table. Usage
  #    feeds the overlay's `queries` aspect (Option B: the queries aspect
  #    lands on the overlay entry, not on the live 1P table) — see
  #    _OVERLAY_MANIFEST in kcmd_tools.py which now declares
  #    dataplex-types.global.queries in publishing.aspects so the push picks
  #    up the <overlay_id>.queries.md sidecar.
  async def _fetch_usage_or_empty():
    if not include_usage:
      print("[BQ Usage] ⏭️  Skipped (--include_usage=false).", flush=True)
      return {}
    table_ids = [m["table"] for m in tables]
    print(
        f"[BQ Usage] 📊 Fetching query history (window={usage_window_days}d,"
        f" scope={usage_scope}) for {len(table_ids)} table(s)...",
        flush=True,
    )
    by_table = await asyncio.to_thread(
        bq_usage_tools.fetch_dataset_usage,
        project,
        dataset_id,
        table_ids,
        window_days=usage_window_days,
        anonymize_users=anonymize_users,
        scope=usage_scope,
    )
    hits = sum(1 for u in by_table.values() if u.total_queries > 0)
    print(
        f"[BQ Usage] ✅ {hits}/{len(table_ids)} table(s) have usage signal"
        " in the window.",
        flush=True,
    )
    return by_table

  doc_descriptors, usage_by_table = await asyncio.gather(
      _prepare_all_docs(
          topic,
          folders,
          docs,
          usage_acc,
          model,
          repo=repo,
          repo_ref=repo_ref,
          repo_subdir=repo_subdir,
          mcp_config=mcp_config,
      ),
      _fetch_usage_or_empty(),
  )
  if not doc_descriptors:
    print(
        "[Folder] ⚠️  No document context — overlays will be documented from"
        " the base entry / schema only.",
        flush=True,
    )

  # 3. Per-table routing — pick relevant folder docs for each table.
  print(
      f"\n[Agent] 🧮 Routing folder docs to {len(tables)} table(s)...",
      flush=True,
  )
  sem = asyncio.Semaphore(CONCURRENCY_LIMIT)

  async def _route_one(meta):
    async with sem:
      selected = await table_mode._route_docs_for_table(
          meta, doc_descriptors, usage_acc, model
      )
      label = (
          ", ".join(
              f"{doc_descriptors[i]['name']} ({s:.2f})" for (i, s) in selected
          )
          or "(none — schema-only)"
      )
      print(f"[Router] {meta['table']} ← {label}", flush=True)
      return meta["table"], selected

  routing = dict(await asyncio.gather(*[_route_one(m) for m in tables]))

  # 4. ENUMERATE — shared EnumerationAgent derives each overlay's canonical id +
  # category (tables seeded 1:1 so every table yields exactly one overlay).
  print(
      f"[Agent] 🧭 Categorizing {len(tables)} table(s) into overlays...",
      flush=True,
  )
  enum_context_lines = [f"DATASET: {project}.{dataset_id}", ""]
  for meta in tables:
    sel = routing.get(meta["table"], [])
    sel_descs = [doc_descriptors[i]["descriptor"][:400] for (i, _s) in sel[:5]]
    enum_context_lines.append(
        f"- {meta['table']}: {meta.get('description', '')[:200]}"
    )
    enum_context_lines.append(
        f"  schema_fields ({len(meta['schema_fields'])}): "
        f"{', '.join(f['name'] for f in meta['schema_fields'][:10])}"
    )
    if sel_descs:
      enum_context_lines.append(
          "  routed_docs:"
          f" {' | '.join(s.splitlines()[0][:120] for s in sel_descs)}"
      )
  enum_context = "\n".join(enum_context_lines)
  seed_entries = [
      {
          "id": m["table"],
          "display_name": m.get("display_name") or m["table"],
          "kind": "table",
      }
      for m in tables
  ]
  enumeration = await common.run_enumeration(
      topic,
      enum_context,
      seed_entries=seed_entries,
      model=model,
      usage_acc=usage_acc,
  )
  cat_by_entry_id = {e.id: c for c in enumeration.categories for e in c.entries}
  print(
      f"[Agent] ✅ {len(enumeration.categories)} categories: "
      f"{[(c.id, len(c.entries)) for c in enumeration.categories]}",
      flush=True,
  )

  # 5. WRITE — overlay overview (fused) + read-only reference copy, per table.
  print(
      "[Agent] 🏗️  Writing overlays via direct Flash (concurrency"
      f" {CONCURRENCY_LIMIT})...",
      flush=True,
  )
  sem2 = asyncio.Semaphore(CONCURRENCY_LIMIT)

  async def _write_one(meta):
    async with sem2:
      table = meta["table"]
      sel = routing.get(table, [])
      sel_docs = [doc_descriptors[i] for (i, _s) in sel]
      cat = cat_by_entry_id.get(table)
      cat_id = cat.id if cat else "uncategorized"
      # overlay id == enumerated entry id (table seeded 1:1).
      overlay_id = table
      table_block = kcmd_tools.flatten_table_for_prompt(meta)

      if sel_docs:
        context = "\n\n".join(
            f"--- DOCUMENT: {d['name']} ({d['url']})"
            f" ---\n{d['content'][:MAX_DOC_CHARS]}"
            for d in sel_docs
        )
      else:
        context = (
            "(none — document this table from its base entry / schema only)"
        )

      # Same SQL-suppression directive as table_mode: SQL examples belong in
      # the queries aspect (written separately by the queries sidecar below),
      # NOT inlined in the overlay overview body.
      overlay_directive = (
          "\n\nIMPORTANT — CONTEXT-OVERLAY MODE: Do NOT include any SQL"
          " query examples in the overview body (no ```sql blocks, no inline"
          " queries). SQL examples are captured separately in this overlay"
          " entry's `queries` aspect by another pipeline step. The overview"
          " should describe WHAT the table is and HOW it's used in narrative"
          " prose, while leaving the runnable SQL to the queries aspect."
      )
      # Per-overlay feedback routing. Overlay entries are 1:1 with their
      # source BQ table, so the routing key is the underlying table's FQN
      # (not the overlay entry id which lives in a different EG).
      table_fqn = f"{project}.{dataset_id}.{table}"
      table_feedback = feedback_tools.route_proposals_to_table(
          all_feedback, table_fqn
      )
      if table_feedback:
        print(
            f"[Feedback] 📝 {table_fqn}: {len(table_feedback)} proposal(s)"
            " applied to overlay — OVERRIDE conflicting context.",
            flush=True,
        )
      feedback_block = feedback_tools.proposals_to_prompt_block(table_feedback)
      overlay_prompt = (
          f"TOPIC: {topic}\n\nOVERLAY ID: {overlay_id}\n\n"
          "=== AUTHORITATIVE BASE ENTRY (1P, read-only) ===\n"
          f"{table_block}\n\n"
          "=== RELEVANT CONTEXT DOCUMENTS (routed for this table only) ===\n"
          f"{context}\n\n"
          "Write the fused context-overlay overview Markdown body now."
          + overlay_directive
          + feedback_block
      )
      overlay_overview = await common.generate_text_direct(
          OVERLAY_WRITER_INSTRUCTION, overlay_prompt, _light_model(model), usage_acc
      )

      # The read-only `<table>.ref.*` mirror is written by `kcmd reference`
      # itself (into the same source subfolder); we only add the overlay pair.
      written = _write_overlay_files(
          output_dir,
          eg_project,
          eg_location,
          eg_id,
          project,
          dataset_id,
          overlay_id,
          table,
          meta,
          cat_id,
          overlay_overview,
      )

      # Merge INFORMATION_SCHEMA-derived patterns with SQL examples extracted
      # from routed docs into a `<overlay_id>.queries.md` sidecar that lands
      # next to the overlay yaml. Reuses table_mode's extract + writer helpers
      # because the overlay sidecar path == bq dataset_dir (overlay_id == table
      # name; standard.ts matches the `.queries` suffix back to the
      # `dataplex-types.global.queries` key declared in _OVERLAY_MANIFEST).
      # Option B routing: the queries aspect attaches to the OVERLAY entry in
      # the editable EG, not to the 1P @bigquery entry — pushing this CL's
      # output never modifies the live table.
      usage = usage_by_table.get(table) if usage_by_table else None
      feedback_queries = feedback_tools.proposals_to_queries(table_feedback)
      # Same gate as table_mode: run the extractor whenever ANY signal is
      # available — a non-None TableUsage (even with 0 patterns from a 403
      # fallback to JOBS_BY_USER) or feedback. Gating on
      # `usage.total_queries > 0` would silently drop doc-extracted SQL on
      # tables in projects where the caller lacks `bigquery.jobs.listAll`,
      # which was the bug that motivated the table_mode fix.
      if (usage or feedback_queries) and output_dir:
        # Floor usage so the writer doesn't crash when only feedback or
        # only docs supplied SQL (INFORMATION_SCHEMA returned nothing).
        if usage is None:
          usage = bq_usage_tools.TableUsage(window_days=usage_window_days)
        doc_queries = await table_mode.extract_doc_queries(
            meta, sel_docs, project, dataset_id, model, usage_acc
        )
        queries_path = table_mode.write_queries_sidecar(
            output_dir,
            project,
            dataset_id,
            meta,
            usage,
            doc_queries,
            feedback_queries=feedback_queries,
        )
        if queries_path:
          written.append(queries_path)
        if doc_queries or feedback_queries:
          print(
              f"[DocQueries] {table}: {len(doc_queries)} doc-extracted"
              f" + {len(feedback_queries)} user-feedback SQL example(s)",
              flush=True,
          )
      print(
          f"[Agent] ✅ {cat_id}/{overlay_id}: wrote {', '.join(written)}",
          flush=True,
      )
      # Per-entry state for multi-turn refinement. A refinement overwrites only
      # the overlay overview sidecar (the overlay YAML is unchanged); docs aren't
      # re-read.
      entry_state = refine.EntryState(
          entry_id=overlay_id,
          display_name=meta.get("display_name") or table,
          description=meta.get("description", "") or "",
          category_id=cat_id,
          grounding_prompt=overlay_prompt,
          writer_model=_light_model(model),
          overview_body=overlay_overview,
          overview_path=os.path.join(
              output_dir,
              "catalog",
              "bigquery",
              project,
              dataset_id,
              f"{overlay_id}.overview.md",
          ),
          kind="table",
      )
      return meta, sel_docs, overlay_overview, entry_state

  results = await asyncio.gather(*[_write_one(m) for m in tables])

  # 6. Persist trajectory (mirrors table mode): per-source fetches first
  # (fetch_gdoc/read_local_md/explore_repo) so eval counts tool calls
  # consistently and grounds hallucination on clean per-doc content; route_docs
  # keeps only the routing (name/url), not content, to avoid duplicating it.
  tool_uses, tool_responses = common.doc_tool_calls(doc_descriptors)
  tool_uses.extend(
      {"name": "reference_table", "args": {"table": m["table"]}} for m in tables
  )
  tool_responses.extend(
      {
          "name": "reference_table",
          "response": {
              "table": m["table"],
              "schema_fields": m["schema_fields"],
          },
      }
      for m in tables
  )
  for meta, sel_docs, _text, _es in results:
    tool_uses.append({"name": "route_docs", "args": {"table": meta["table"]}})
    tool_responses.append({
        "name": "route_docs",
        "response": {
            "table": meta["table"],
            "relevant_docs": [
                {"name": d["name"], "url": d["url"]} for d in sel_docs
            ],
        },
    })
  tool_uses.append({"name": "enumerate", "args": {"topic": topic}})
  tool_responses.append(
      {"name": "enumerate", "response": enumeration.model_dump()}
  )
  final_text = "\n\n".join(t for (_m, _d, t, _es) in results)
  traj_user_input = (
      f"TOPIC: {topic} | DATASET: {project}.{dataset_id} | EG: {entry_group}"
  )
  common.write_trajectory(
      output_dir,
      "context_overlay",
      traj_user_input,
      tool_uses,
      tool_responses,
      final_text,
      usage_acc,
      latency=time.monotonic() - _t0,
  )
  print(f"[Cache] doc-fetch stats: {get_cache_stats()}", flush=True)

  # Build the refinement session (consumed by agent_runner --interactive).
  return refine.EnrichmentSession(
      mode="context_overlay",
      topic=topic,
      model=model,
      output_dir=output_dir,
      entries={es.entry_id: es for (_m, _d, _t, es) in results},
      usage_acc=usage_acc,
      # Phase-2 state for a `reenumerate` refinement. Overlay entries are pinned
      # 1:1 to the dataset's tables, so re-enumeration only re-categorizes — see
      # apply_reenumeration below.
      enum_context=enum_context,
      writer_params={
          "project": project,
          "dataset_id": dataset_id,
          "eg_project": eg_project,
          "eg_location": eg_location,
          "eg_id": eg_id,
      },
      traj_meta={
          "agent_type": "context_overlay",
          "user_input": traj_user_input,
          "tool_uses": tool_uses,
          "tool_responses": tool_responses,
      },
  )


def _set_overlay_category(
    output_dir: str, project: str, dataset_id: str, overlay_id: str, cat_id: str
) -> None:
  """Rewrite the `category:` field on an overlay entry YAML (best-effort)."""
  path = os.path.join(
      output_dir,
      "catalog",
      "bigquery",
      project,
      dataset_id,
      f"{overlay_id}.yaml",
  )
  if not os.path.exists(path):
    return
  try:
    with open(path) as f:
      data = yaml.safe_load(f) or {}
    data["category"] = cat_id
    with open(path, "w") as f:
      yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
  except (OSError, yaml.YAMLError):
    pass


async def apply_reenumeration(session, new_enum, removed_ids) -> None:
  """Materialize a context-overlay re-enumeration delta — re-categorization ONLY.

  Like table mode, overlay entries are pinned 1:1 to the dataset's tables, so a
  re-enumeration can neither add nor remove an overlay. We apply only category
  changes by rewriting the `category:` field on the overlay entry YAML (files
  stay under `catalog/bigquery/{proj}/{dataset}/`). Mutates session.entries.
  """
  wp = session.writer_params or {}
  project = wp.get("project", "")
  dataset_id = wp.get("dataset_id", "")
  output_dir = session.output_dir
  new_cat_by_id = {
      e.id: cat for cat in new_enum.categories for e in cat.entries
  }
  if removed_ids:
    print(
        "[refine] ℹ️  context_overlay mode: overlays are pinned to the dataset"
        f" — cannot remove {sorted(set(removed_ids))}; applying category"
        " changes only.",
        flush=True,
    )
  for eid, es in session.entries.items():
    cat = new_cat_by_id.get(eid)
    if cat is None or cat.id == es.category_id:
      continue
    _set_overlay_category(output_dir, project, dataset_id, eid, cat.id)
    es.category_id = cat.id
    print(f"[refine] 🔀 recategorized {eid} -> {cat.id}", flush=True)
