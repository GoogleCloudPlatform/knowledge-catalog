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

import common
from engine import (
    OVERLAY_WRITER_INSTRUCTION,
    create_doc_summarizer_runner,
)
from modes import doc_mode
from modes import table_mode
import refine
from tools import bq_usage_tools
from tools import feedback_tools
from tools import confluence_tools, github_tools, sharepoint_tools
from tools import kcmd_tools
from tools.drive_tools import (
    extract_gdoc_id,
    fetch_doc_text,
    get_cache_stats,
    is_local_path,
    list_local_md,
    read_local_md,
)
import yaml

# Overlay entries are generic-typed in the editable entry group; the enriched
# content lands in the `overview` aspect (same convention as doc mode).
_OVERLAY_ENTRY_TYPE = "dataplex-types.global.generic"
# Flash for the per-table writers (small inputs) — matches table mode.
_WRITER_MODEL = os.environ.get("KC_LIGHT_MODEL", "gemini-2.5-flash")
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


def source_entry_name(ref_project: str, eg_location: str, ref_dataset: str,
                      table: str) -> str:
  """The @bigquery entry FQN of the REAL 1P BigQuery table that an overlay entry
  temporarily links to via its `resource.name` (see `_write_overlay_files`), so
  consumers can associate the overlay with its source table. Pure/testable."""
  return (
      f"projects/{ref_project}/locations/{eg_location}/entryGroups/"
      "@bigquery/entries/bigquery.googleapis.com/projects/"
      f"{ref_project}/datasets/{ref_dataset}/tables/{table}")


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
      raw = await common.run_text(
          create_doc_summarizer_runner(model), prompt, usage_acc
      )
    # Split off the <CONCEPTS> block exactly like table_mode._prepare_docs, so
    # doc-URL-grounded overlays/hybrid also feed the shared-concepts injection
    # (and the routing descriptor isn't polluted with the concepts JSON). Tables
    # are normalized later by _aggregate_concepts, so pass table_names=None here.
    descriptor, concepts = table_mode._split_descriptor_concepts(raw, None)
    return {
        "id": idx,
        "name": name,
        "url": ident,
        "content": content,
        "descriptor": descriptor,
        "concepts": concepts,
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
    confluence_spaces: list[str] | None = None,
    confluence_cql: list[str] | None = None,
    confluence_page_ids: list[str] | None = None,
    sharepoint_sites: list[str] | None = None,
    sharepoint_search: list[str] | None = None,
    sharepoint_file_ids: list[str] | None = None,
    confluence_docs: list[dict] | None = None,
    sharepoint_docs: list[dict] | None = None,
) -> list[dict]:
  """Build the router-descriptor doc list from folders, explicit docs, and/or a

  GitHub repo, Confluence corpus, and/or SharePoint corpus.

  `folders` and `doc_urls` are mixed lists routed per entry (Drive vs local
  markdown). The router indexes docs by their `id` == list position, so ids are
  reassigned sequentially after merging the sources. Code component cards
  (--repo), Confluence page cards (--confluence_*), and SharePoint file cards
  (--sharepoint_*) join the pool in the same shape and are routed to tables
  like any other candidate document.

  `confluence_docs` / `sharepoint_docs`, when provided, are pre-gathered cards
  reused as-is instead of re-fetching (the hybrid doc-mode path passes the
  cards it already gathered for its KB entries, so the corpus is explored
  once). When None, the corpus is gathered from the `confluence_*` /
  `sharepoint_*` query params as usual.
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
  # Reuse pre-gathered cards (hybrid path) or gather the corpus now.
  conf_docs = (
      confluence_docs
      if confluence_docs is not None
      else await confluence_tools.gather_confluence_context(
          confluence_spaces,
          confluence_cql,
          confluence_page_ids,
          topic,
          model,
          usage_acc,
          mcp_config_path=mcp_config or None,
      )
  )
  for d in conf_docs:
    d["_kind"] = "confluence"
  docs.extend(conf_docs)
  sp_docs = (
      sharepoint_docs
      if sharepoint_docs is not None
      else await sharepoint_tools.gather_sharepoint_context(
          sharepoint_sites,
          sharepoint_search,
          sharepoint_file_ids,
          topic,
          model,
          usage_acc,
      )
  )
  for d in sp_docs:
    d["_kind"] = "sharepoint"
  docs.extend(sp_docs)
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
  by `kcmd reference` itself; `_move_into_table_folder` (called by the caller)
  relocates it into this same per-table folder so every resource for a table
  co-locates.
  """
  # Per-table folder: all of this table's resources live under
  # catalog/bigquery/<proj>/<dataset>/<table>/ so the index hierarchy can give
  # the table its own `index` entry and parent the overlay to it.
  rel_dir = os.path.join("catalog", "bigquery", ref_project, ref_dataset, table)
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
          # Temporarily link the overlay entry to the REAL 1P BigQuery table
          # entry via resource.name (the @bigquery entry FQN) so consumers can
          # associate the overlay with its source table. Hybrid reaches this same
          # writer via generate_overlays, so its overlays carry the link too.
          "name": source_entry_name(ref_project, eg_location, ref_dataset, table),
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


def _move_into_table_folder(
    output_dir: str, project: str, dataset_id: str, table: str, filename: str
) -> str | None:
  """Relocate a flat dataset-dir file into the per-table folder. Idempotent.

  `kcmd reference` writes the read-only mirror (`<table>.ref.yaml` /
  `<table>.ref.overview.md`) and `table_mode.write_queries_sidecar` writes
  `<table>.queries.md` into the FLAT `catalog/bigquery/<proj>/<dataset>/` dir.
  This moves them into `.../<dataset>/<table>/` so every resource for a table
  co-locates. Moving is push-safe: the STANDARD layout indexes entries by their
  YAML `name:` field via a recursive walk, not by file path. `os.replace`
  overwrites any stale copy from a prior run. Returns the new rel path, or None
  if the source file does not exist.
  """
  base = os.path.join(output_dir, "catalog", "bigquery", project, dataset_id)
  src = os.path.join(base, filename)
  if not os.path.exists(src):
    return None
  dst_dir = os.path.join(base, table)
  os.makedirs(dst_dir, exist_ok=True)
  os.replace(src, os.path.join(dst_dir, filename))
  return os.path.join(
      "catalog", "bigquery", project, dataset_id, table, filename
  )


async def generate_overlays(
    output_dir: str,
    project: str,
    dataset_id: str,
    eg_project: str,
    eg_location: str,
    eg_id: str,
    entry_group: str,
    topic: str,
    model: str,
    folders: list[str] | None,
    docs: list[str] | None,
    all_feedback: list | None,
    glossary_scope: str | None,
    usage_acc: dict,
    *,
    tables_filter: list[str] | None = None,
    include_usage: bool = True,
    usage_window_days: int = 30,
    anonymize_users: bool = False,
    usage_scope: str = "auto",
    repo: str = "",
    repo_ref: str = "",
    repo_subdir: str = "",
    mcp_config: str = "",
    confluence_spaces: list[str] | None = None,
    confluence_cql: list[str] | None = None,
    confluence_page_ids: list[str] | None = None,
    sharepoint_sites: list[str] | None = None,
    sharepoint_search: list[str] | None = None,
    sharepoint_file_ids: list[str] | None = None,
    confluence_docs: list[dict] | None = None,
    sharepoint_docs: list[dict] | None = None,
    build_index: bool = True,
) -> dict | None:
  """Generate per-table context-overlay entries into an ALREADY-scaffolded EG
  (caller ran init_reference). Co-locates each table\'s files in a per-table
  folder and (when build_index) builds the per-folder index hierarchy. Returns
  results + the trajectory slice + dir_meta so the hybrid caller can build ONE
  combined index. None if no tables were referenced. Shared by run() and the
  hybrid path of doc_mode.run()."""
  all_feedback = all_feedback or []
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
          confluence_spaces=confluence_spaces,
          confluence_cql=confluence_cql,
          confluence_page_ids=confluence_page_ids,
          sharepoint_sites=sharepoint_sites,
          sharepoint_search=sharepoint_search,
          sharepoint_file_ids=sharepoint_file_ids,
          confluence_docs=confluence_docs,
          sharepoint_docs=sharepoint_docs,
      ),
      _fetch_usage_or_empty(),
  )
  if not doc_descriptors:
    print(
        "[Folder] ⚠️  No document context — overlays will be documented from"
        " the base entry / schema only.",
        flush=True,
    )

  # v3 cross-table concepts (same mechanism as table mode): the per-doc
  # <CONCEPTS> blocks extracted during summarization are merged once into the
  # dataset's shared-concept list, then injected per overlay below (only the
  # concepts that name that table). This is what makes a cross-table fact stated
  # in table A's doc reach table B's overlay. Shared verbatim with table mode via
  # table_mode.build_shared_concept_block + cross_table_context_section. Hybrid
  # reaches this same path (doc_mode.run -> generate_overlays).
  print(
      "[Agent] 🔗 Aggregating per-doc cross-table concepts for overlays...",
      flush=True,
  )
  shared_concepts = await table_mode._aggregate_concepts(
      doc_descriptors, table_names, usage_acc)
  print(f"[Agent] ✅ {len(shared_concepts)} shared concept(s).", flush=True)

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
      # v3 cross-table concepts — same additive injection as table mode (shared
      # helper guarantees identical wording + the "additional, never drop a doc
      # fact" contract across modes).
      shared_block = table_mode.build_shared_concept_block(
          shared_concepts, table)
      overlay_prompt = (
          f"TOPIC: {topic}\n\nOVERLAY ID: {overlay_id}\n\n"
          "=== AUTHORITATIVE BASE ENTRY (1P, read-only) ===\n"
          f"{table_block}\n\n"
          "=== RELEVANT CONTEXT DOCUMENTS (routed for this table only) ===\n"
          f"{context}\n\n"
          + table_mode.cross_table_context_section(shared_block)
          + "\n\nWrite the fused context-overlay overview Markdown body now."
          + overlay_directive
          + feedback_block
      )
      overlay_overview = await common.generate_text_direct(
          OVERLAY_WRITER_INSTRUCTION, overlay_prompt, _WRITER_MODEL, usage_acc
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

      # Co-locate the read-only 1P mirror (written flat by `kcmd reference`)
      # into this table's folder so all of the table's resources live together.
      # (Not added to `written`: the `.ref.*` pair is read-only, filtered from
      # publishing, and never pushed by us.)
      for _fn in (f"{table}.ref.yaml", f"{table}.ref.overview.md"):
        _move_into_table_folder(output_dir, project, dataset_id, table, _fn)

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
        table_mode.write_queries_sidecar(
            output_dir,
            project,
            dataset_id,
            meta,
            usage,
            doc_queries,
            feedback_queries=feedback_queries,
        )
        # write_queries_sidecar writes `<table>.queries.md` flat; move it into
        # the per-table folder alongside the overlay + ref mirror.
        moved_queries = _move_into_table_folder(
            output_dir, project, dataset_id, table, f"{table}.queries.md"
        )
        if moved_queries:
          written.append(moved_queries)
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
          writer_model=_WRITER_MODEL,
          overview_body=overlay_overview,
          overview_path=os.path.join(
              output_dir,
              "catalog",
              "bigquery",
              project,
              dataset_id,
              table,
              f"{overlay_id}.overview.md",
          ),
          kind="table",
      )
      return meta, sel_docs, overlay_overview, entry_state

  results = await asyncio.gather(*[_write_one(m) for m in tables])

  # 5b. Optional entity-level linking: when --glossaries was supplied, tag
  # each overlay entry with related glossary terms. The link is anchored on
  # the overlay entry (SOURCE = overlay in user EG, TARGET = glossary term),
  # so the link resource lives in the user's overlay EG and round-trips via
  # kcmd pull/push — full version control, no @bigquery dependency.
  if glossary_scope and output_dir:
    import linking

    entries_for_linking = []
    for meta, _sel_docs, overlay_text, _es in results:
      # Overlay entries now live in their per-table folder.
      overlay_yaml_path = os.path.join(
          output_dir,
          "catalog",
          "bigquery",
          project,
          dataset_id,
          meta["table"],
          f"{meta['table']}.yaml",
      )
      if not os.path.exists(overlay_yaml_path):
        continue
      summary = (overlay_text or "")[:5000]
      entries_for_linking.append((overlay_yaml_path, meta["table"], summary))

    def _inject_overlay_links(path: str, new_links: list[dict]):
      # Inject as `definition` (directed) so push reconciliation works the
      # same as table mode; see doc_mode._inject_kb_links rationale.
      with open(path) as f:
        data = yaml.safe_load(f) or {}
      data.setdefault("links", {}).setdefault("definition", [])
      existing_ids = {l.get("id") for l in data["links"]["definition"]}
      for nl in new_links:
        if nl["id"] not in existing_ids:
          data["links"]["definition"].append(nl)
      with open(path, "w") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)

    print(
        "[Linking] 🔗 Tagging overlay entries with glossary terms ...",
        flush=True,
    )
    n = await linking.apply_entity_linking(
        output_dir,
        model,
        entries_for_linking,
        _inject_overlay_links,
        usage_acc,
    )
    print(f"[Linking] ✅ Tagged {n} overlay(s) with related terms.", flush=True)

  # Per-table folder index titles, then (standalone) build the folder index
  # hierarchy. Hybrid passes build_index=False and builds ONE combined index in
  # doc_mode using the returned dir_meta.
  dir_meta: dict = {}
  for meta, _sd, _t, _es in results:
    tk = f"bigquery/{project}/{dataset_id}/{meta['table']}"
    dir_meta[tk] = (
        meta.get("display_name") or meta["table"],
        meta.get("description") or f"Context overlay for {meta['table']}.",
    )
  if build_index and output_dir:
    resource_name_prefix = (
        f"projects/{eg_project}/locations/{eg_location}/catalog")
    eg_full_name = (
        f"projects/{eg_project}/locations/{eg_location}/entryGroups/{eg_id}")
    print("[Agent] 🗂️  Building folder index entries + parent/child links ...",
          flush=True)
    doc_mode._build_index_hierarchy(
        output_dir, eg_full_name, _OVERLAY_ENTRY_TYPE, resource_name_prefix,
        topic, dir_meta)

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
  return {
      "results": results,
      "doc_descriptors": doc_descriptors,
      "enumeration": enumeration,
      "enum_context": enum_context,
      "tables": tables,
      "usage_by_table": usage_by_table,
      "shared_concepts": shared_concepts,
      "tool_uses": tool_uses,
      "tool_responses": tool_responses,
      "final_text": final_text,
      "dir_meta": dir_meta,
  }


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
    glossaries: list[str] | None = None,
    output_format: str = "kcmd",
    confluence_spaces: list[str] | None = None,
    confluence_cql: list[str] | None = None,
    confluence_page_ids: list[str] | None = None,
    sharepoint_sites: list[str] | None = None,
    sharepoint_search: list[str] | None = None,
    sharepoint_file_ids: list[str] | None = None,
):
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
  # Optional glossary: when supplied, the overlay manifest declares
  # `entryLinks: [related]` so overlay→term links round-trip via pull/push,
  # and after overlay entries are written we run the EntityLinkingAgent to
  # tag each overlay with relevant glossary terms. The link is anchored on
  # the overlay entry (in the user's EG), so the link resource lives in
  # the user's EG and is fully version-controlled — distinct from the
  # table-mode case where links must live in `@bigquery`.
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

  print(
      f"[kcmd] 🔎 Referencing {project}.{dataset_id} via kcmd reference"
      f"{' (with glossary links)' if glossary_scope else ''} ...",
      flush=True,
  )
  ok, msg = await asyncio.to_thread(
      kcmd_tools.init_reference,
      output_dir,
      entry_group,
      project,
      dataset_id,
      _OVERLAY_ENTRY_TYPE,
      bool(glossary_scope),
  )
  print(f"[kcmd] {'OK' if ok else '⚠️  FAILED'}: {msg}", flush=True)

  if glossary_scope:
    # Side-channel glossary pull (catalog.yaml is preserved across the swap).
    eg_project = entry_group.split(".")[0]
    print(
        f"[kcmd] 🔎 Pulling glossary terms ({glossary_scope}) as reference ...",
        flush=True,
    )
    ok_g, msg_g = await asyncio.to_thread(
        kcmd_tools.pull_glossary_as_reference,
        output_dir,
        eg_project,
        glossary_scope,
    )
    print(
        f"[kcmd] {'OK' if ok_g else '⚠️  FAILED'} (glossary reference):"
        f" {msg_g}",
        flush=True,
    )

  core = await generate_overlays(
      output_dir, project, dataset_id, eg_project, eg_location, eg_id,
      entry_group, topic, model, folders, docs, all_feedback, glossary_scope,
      usage_acc, tables_filter=tables_filter, include_usage=include_usage,
      usage_window_days=usage_window_days, anonymize_users=anonymize_users,
      usage_scope=usage_scope, repo=repo, repo_ref=repo_ref,
      repo_subdir=repo_subdir, mcp_config=mcp_config,
      confluence_spaces=confluence_spaces, confluence_cql=confluence_cql,
      confluence_page_ids=confluence_page_ids,
      sharepoint_sites=sharepoint_sites, sharepoint_search=sharepoint_search,
      sharepoint_file_ids=sharepoint_file_ids, build_index=True)
  if core is None:
    return None
  results = core["results"]
  enum_context = core["enum_context"]
  tool_uses = core["tool_uses"]
  tool_responses = core["tool_responses"]
  traj_user_input = (
      f"TOPIC: {topic} | DATASET: {project}.{dataset_id} | EG: {entry_group}")
  common.write_trajectory(
      output_dir, "context_overlay", traj_user_input, tool_uses,
      tool_responses, core["final_text"], usage_acc)
  print(f"[Cache] doc-fetch stats: {get_cache_stats()}", flush=True)

  # OKF output: convert the finished catalog/ tree into an OKF bundle/.
  common.maybe_convert_to_okf(output_dir, output_format)

  return refine.EnrichmentSession(
      mode="context_overlay",
      topic=topic,
      model=model,
      output_dir=output_dir,
      entries={es.entry_id: es for (_m, _d, _t, es) in results},
      usage_acc=usage_acc,
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
  # Overlay entries live in their per-table folder (overlay_id == table name).
  path = os.path.join(
      output_dir,
      "catalog",
      "bigquery",
      project,
      dataset_id,
      overlay_id,
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
  re-enumeration can neither add nor remove an overlay. We apply only the
  `category:` field on each overlay entry YAML; the per-table folder structure
  (which drives the index hierarchy) is keyed by table name, not category, so the
  on-disk tree and its parent links are unchanged. The index hierarchy is then
  rebuilt defensively to stay consistent. Mutates session.entries.
  """
  wp = session.writer_params or {}
  project = wp.get("project", "")
  dataset_id = wp.get("dataset_id", "")
  eg_project = wp.get("eg_project", "")
  eg_location = wp.get("eg_location", "")
  eg_id = wp.get("eg_id", "")
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

  # Keep the per-folder index entries + parent links consistent (idempotent).
  if output_dir and eg_project:
    resource_name_prefix = (
        f"projects/{eg_project}/locations/{eg_location}/catalog"
    )
    eg_full_name = (
        f"projects/{eg_project}/locations/{eg_location}/entryGroups/{eg_id}"
    )
    dir_meta = {
        cat.id: (cat.title, cat.description) for cat in new_enum.categories
    }
    for eid, es in session.entries.items():
      tk = f"bigquery/{project}/{dataset_id}/{eid}"
      dir_meta[tk] = (es.display_name or eid, es.description or "")
    doc_mode._build_index_hierarchy(
        output_dir,
        eg_full_name,
        _OVERLAY_ENTRY_TYPE,
        resource_name_prefix,
        session.topic,
        dir_meta,
    )
