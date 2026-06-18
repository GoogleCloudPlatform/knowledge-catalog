"""Table mode: Dataplex-sourced, folder-grounded BigQuery table enrichment.

Discovers a BigQuery dataset's tables via the Dataplex Catalog, then for EACH
table
routes only the relevant Drive-folder documents to it (via an LLM relevance
router)
and enriches it with Metadata-as-Code (an entry YAML + an overview sidecar)
grounded
in those documents. Tables with no relevant docs get a schema-only overview.
Output
is scoped to the dataset's real `@bigquery` entry group so the overview can land
on
the live Dataplex entries. Ported from the former table_agent_runner.
"""

import asyncio
import json
import os
import re
import typing as t
import common
from engine import (
    create_doc_query_extractor_runner,
    create_doc_summarizer_runner,
    create_router_runner,
    create_table_overview_runner,
)
import refine
from tools import bq_usage_tools
from tools import feedback_tools
from tools import confluence_tools, github_tools, sharepoint_tools
from tools import kcmd_tools
from tools.drive_tools import (
    extract_folder_id,
    fetch_doc_text,
    is_local_path,
    list_folder_files,
    list_local_md,
    read_local_md,
)
import yaml

# kcmd's canonical entry type for BigQuery tables under a bq-dataset scope.
_BQ_TABLE_TYPE = "dataplex-types.global.bigquery-table"

CONCURRENCY_LIMIT = (
    12  # parallel LLM calls (doc summaries, routing, per-table gen)
)
RELEVANCE_THRESHOLD = 0.5  # min router score for a doc to feed a table
MAX_DOC_CHARS = (
    30000  # per-doc content budget when building a table's focused context
)


def _parse_dataset(dataset: str) -> tuple[str, str]:
  """`project.dataset` -> (project, dataset). The project must be explicit."""
  dataset = (dataset or "").strip()
  if "." not in dataset:
    raise ValueError(
        "--dataset must be fully qualified as `project.dataset` (got"
        f" '{dataset}')."
    )
  project, ds = dataset.split(".", 1)
  return project, ds


def _write_table_files(
    output_dir: str,
    project: str,
    dataset_id: str,
    meta: t.Dict[str, t.Any],
    overview_body: str,
) -> list[str]:
  """Add the enriched overview sidecar next to the table entry that

  `kcmd init --pull` already wrote. We do NOT rewrite the entry YAML — the
  pulled entry (with its 1P schema/storage aspects) is the source of truth; we
  only contribute the `overview` aspect via a `<table>.overview.md` sidecar
  (md-sidecar support), and publish only that aspect.
  """
  if not output_dir:
    return []
  table = meta["table"]
  abs_dir = kcmd_tools._dataset_dir(  # pylint: disable=protected-access
      output_dir, project, dataset_id
  )
  rel_dir = os.path.relpath(abs_dir, output_dir)
  os.makedirs(abs_dir, exist_ok=True)

  # If the pull somehow didn't produce the entry, write a minimal one so push
  # still has a target.
  entry_path = os.path.join(abs_dir, f"{table}.yaml")
  if not os.path.exists(entry_path):
    resource = {
        "name": f"projects/{project}/datasets/{dataset_id}/tables/{table}",
        "displayName": table,
    }
    if meta.get("description"):
      resource["description"] = meta["description"]
    with open(entry_path, "w") as f:
      yaml.safe_dump(
          {
              "name": f"bigquery/{project}/{dataset_id}/{table}",
              "type": _BQ_TABLE_TYPE,
              "resource": resource,
              "aspects": {},
          },
          f,
          sort_keys=False,
          allow_unicode=True,
      )

  # Overview sidecar — pure Markdown body, NO frontmatter. kcmd merges any
  # sidecar frontmatter straight into the aspect payload (standard layout), and
  # the live `dataplex-types.global.overview` aspectType only accepts
  # content/contentType — emitting e.g. `userManaged` makes `kcmd push` fail
  # with "Unknown property". contentType=MARKDOWN is inferred from the
  # `.overview` suffix on load, so no frontmatter is needed.
  overview_path = os.path.join(abs_dir, f"{table}.overview.md")
  with open(overview_path, "w") as f:
    f.write(common.clean_overview_body(overview_body) + "\n")

  # kcmd's standard layout (see toolbox/mdcode/src/libts/layouts/standard.ts)
  # routes BOTH `<table>.overview.md` AND
  # `<table>.dataplex-types.global.overview.md`
  # to the same aspect key — files are processed in readdir order and the
  # last one wins via `Object.assign + content`. `kcmd pull` produces the
  # fully-qualified-suffix file as a side effect, and on most filesystems
  # it sorts AFTER our short-suffix file, so without this deletion the
  # pulled (existing live) content silently overwrites the agent's new
  # overview on push — kcmd reports success but Dataplex never changes.
  # We delete the pulled sidecar after writing our own so there's exactly
  # one source of truth for the overview aspect.
  pulled = os.path.join(abs_dir, f"{table}.dataplex-types.global.overview.md")
  if os.path.exists(pulled):
    try:
      os.remove(pulled)
    except OSError:
      pass

  return [os.path.join(rel_dir, f"{table}.overview.md")]


def _split_descriptor_concepts(raw, table_names):
  """Split the summarizer output into (router descriptor, per-doc concepts).

  The summarizer emits the Title/Summary/Key-entities descriptor followed by a
  <CONCEPTS>[...]</CONCEPTS> JSON block (v3: cross-table facts found in THIS doc).
  We strip the block from the descriptor (so the router prompt is unchanged) and
  return the parsed concept list, normalizing table tags to real dataset tables.
  """
  raw = raw or ""
  concepts = []
  m = re.search(r"<CONCEPTS>(.*?)</CONCEPTS>", raw, re.S)
  if m:
    try:
      arr = json.loads(m.group(1).strip() or "[]")
    except (ValueError, json.JSONDecodeError):
      arr = []
    for c in arr if isinstance(arr, list) else []:
      if not isinstance(c, dict):
        continue
      tabs = [str(t) for t in (c.get("tables") or [])]
      if table_names:
        tabs = [t for t in tabs if t in table_names]
      body = (c.get("body") or "").strip()
      if tabs and body:
        concepts.append({"kind": str(c.get("kind", "")), "tables": tabs,
                         "title": (c.get("title") or "").strip(), "body": body})
  descriptor = re.sub(r"<CONCEPTS>.*?</CONCEPTS>", "", raw, flags=re.S).strip()
  return descriptor, concepts


async def _prepare_docs(
    topic: str,
    folders: list[str] | None,
    usage_acc: t.Dict[str, int],
    model: str,
    table_names: list[str] | None = None,
) -> t.List[t.Dict[str, t.Any]]:
  """Fetch grounding docs from each folder and summarize into router descriptors.

  `folders` is a mixed, comma-separated list routed per entry (see
  drive_tools.is_local_path): a Drive folder URL/ID is listed via the Drive
  API; a local directory (or .md file) grounds overviews from disk. Both are
  summarized the same way.

  Args:
    topic: Focus topic.
    folders: Mixed list of Drive folder URLs/IDs and/or local md dirs/files.
    usage_acc: Usage accumulator.
    model: Model name.

  Returns:
    A list of {id, name, url, content, descriptor, _kind}.
  """
  del topic  # unused
  files = []
  for entry in (folders or []):
    entry = (entry or "").strip()
    if not entry:
      continue
    if is_local_path(entry):
      md_paths = list_local_md(entry)
      files.extend(
          {
              "id": p,
              "name": os.path.basename(p),
              "webViewLink": p,
              "mimeType": "text/markdown",
              "modifiedTime": str(os.path.getmtime(p)),
              "_local": True,
          }
          for p in md_paths
      )
      print(
          f"[Route] --folder {entry!r} -> local markdown ({len(md_paths)}"
          f" file(s), resolved {os.path.abspath(os.path.expanduser(entry))}).",
          flush=True,
      )
    else:
      folder_id = extract_folder_id(entry)
      found = list_folder_files(folder_id)
      files.extend(found)
      print(
          f"[Route] --folder {entry!r} -> Drive folder ({len(found)} file(s)).",
          flush=True,
      )

  if not files:
    return []

  sem = asyncio.Semaphore(CONCURRENCY_LIMIT)

  async def _prep(idx, f):
    fid = f.get("id")
    url = f.get("webViewLink") or fid
    name = f.get("name", "")
    if f.get("_local"):
      content = await asyncio.to_thread(read_local_md, fid)
    else:
      # v5 #2: pass modifiedTime so the per-doc cache invalidates when Drive
      # reports the file changed since the last run.
      content = await asyncio.to_thread(
          fetch_doc_text,
          fid,
          f.get("mimeType", ""),
          modified_time=f.get("modifiedTime"),
      )
    async with sem:
      tbls = f"DATASET TABLES: {table_names}\n\n" if table_names else ""
      prompt = (
          f"{tbls}DOCUMENT TITLE: {name}\nSOURCE URL: {url}\n\nDOCUMENT"
          f" CONTENT:\n{content[:50000]}"
      )
      raw = await common.run_text(
          create_doc_summarizer_runner(model), prompt, usage_acc
      )
    descriptor, concepts = _split_descriptor_concepts(raw, table_names)
    return {
        "id": idx,
        "name": name,
        "url": url,
        "content": content,
        "descriptor": descriptor,
        "concepts": concepts,
        "_kind": "local_md" if f.get("_local") else "gdoc",
    }

  docs = await asyncio.gather(
      *[_prep(i, f) for i, f in enumerate(f for f in files if f.get("id"))]
  )
  return list(docs)


def _parse_router(text: str, n_docs: int) -> list[tuple[int, float]]:
  """Parse the router's JSON array into [(doc_index, score)] above threshold."""
  txt = (text or "").strip()
  m = re.search(r"```(?:json)?\s*(.*?)```", txt, re.S)
  if m:
    txt = m.group(1).strip()
  if not txt.startswith("["):
    m = re.search(r"\[.*\]", txt, re.S)
    txt = m.group(0) if m else "[]"
  try:
    arr = json.loads(txt)
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


async def extract_doc_queries(
    table_meta: t.Dict[str, t.Any],
    sel_docs: t.List[t.Dict[str, t.Any]],
    project: str,
    dataset_id: str,
    model: str,
    usage_acc: t.Dict[str, int],
) -> t.List[t.Dict[str, t.Any]]:
  """Pull SQL examples that reference this table out of its routed docs.

  Returns a list of `{description, sql}` dicts (one per query found),
  ready to merge into the `queries` aspect alongside the
  INFORMATION_SCHEMA-derived patterns. Empty list when no docs are
  routed to this table OR when none of them contain a SQL example
  referencing it.

  The extractor (engine.create_doc_query_extractor_runner) returns
  JSONL — one JSON object per line. We parse line-by-line and silently
  drop unparseable lines so a partial response still yields whatever
  the LLM produced cleanly.

  Args:
    table_meta: Table metadata.
    sel_docs: Selected docs.
    project: Project ID.
    dataset_id: Dataset ID.
    model: Model name.
    usage_acc: Usage accumulator.

  Returns:
    List of query dictionaries.
  """
  if not sel_docs:
    return []
  table_fqn = f"{project}.{dataset_id}.{table_meta['table']}"
  doc_blob = "\n\n".join(
      f"--- DOCUMENT: {d['name']} ({d['url']})"
      f" ---\n{d['content'][:MAX_DOC_CHARS]}"
      for d in sel_docs
  )
  prompt = f"TABLE: {table_fqn}\n\nDOC SNIPPETS:\n{doc_blob}"
  text = await common.run_text(
      create_doc_query_extractor_runner(model), prompt, usage_acc
  )
  out: t.List[t.Dict[str, t.Any]] = []
  for line in (text or "").splitlines():
    line = line.strip()
    if not line or line.startswith("```"):
      continue
    try:
      obj = json.loads(line)
    except json.JSONDecodeError:
      continue
    if not isinstance(obj, dict):
      continue
    desc = (obj.get("description") or "").strip()
    sql = (obj.get("sql") or "").strip()
    if not sql:
      continue
    out.append({"description": desc, "sql": sql})
  return out


def write_queries_sidecar(
    output_dir: str,
    project: str,
    dataset_id: str,
    meta: t.Dict[str, t.Any],
    usage: "bq_usage_tools.TableUsage",
    doc_queries: t.Optional[t.List[t.Dict[str, t.Any]]] = None,
    feedback_queries: t.Optional[t.List[t.Dict[str, t.Any]]] = None,
) -> str:
  """Write the per-table `queries` aspect sidecar as `<table>.queries.md`.

  YAML frontmatter ONLY (no body), conforming to the Dataplex `queries`
  aspect type (`dataplex-types.global.queries`). kcmd
  push uploads this as the `queries` aspect because it's declared in
  publishing.aspects in kcmd_tools._BQ_MANIFEST.

  Three query sources merge into the one aspect:
    1. INFORMATION_SCHEMA observed patterns from `usage`.
    2. SQL examples extracted from the routed documentation
       (`doc_queries`, from `extract_doc_queries`).
    3. User-feedback golden_sql payloads (`feedback_queries`, from
       feedback_tools.proposals_to_queries) — these are ground-truth
       SQL from direct user feedback proposals and emit FIRST in the
       aspect (most prominent) with `source: USER`.

  Each is attributed in the description prefix (`[Source:
  INFORMATION_SCHEMA]` / `[Source: Documentation]` / `[Source: User
  Feedback]`); the aspect's `source` enum is closed (AGENT | USER) per
  the proto schema — AGENT for the first two sources, USER for the
  feedback-derived entries.

  The queries aspect requires the `dataplex.entryGroups.useQueriesAspect`
  permission per the aspect's `authorization.alternate_use_permission`
  declaration; if the caller lacks the perm, kcmd push will fail with 403
  on the queries aspect specifically. The overview aspect still goes through.

  Args:
    output_dir: Output directory.
    project: Project ID.
    dataset_id: Dataset ID.
    meta: Table metadata.
    usage: Table usage data.
    doc_queries: SQL extracted from routed documentation (AGENT source).
    feedback_queries: SQL from direct user-feedback proposals (USER source).
      Highest priority — emitted first in the sidecar.

  Returns:
    Path to the written sidecar.
  """
  table = meta["table"]
  abs_dir = kcmd_tools._dataset_dir(  # pylint: disable=protected-access
      output_dir, project, dataset_id
  )
  rel_dir = os.path.relpath(abs_dir, output_dir)
  os.makedirs(abs_dir, exist_ok=True)
  table_fqn = f"{project}.{dataset_id}.{table}"
  path = os.path.join(abs_dir, f"{table}.queries.md")
  with open(path, "w") as f:
    f.write(
        bq_usage_tools.format_queries_sidecar(
            usage,
            table_fqn,
            doc_queries=doc_queries,
            feedback_queries=feedback_queries,
        )
    )
  return os.path.join(rel_dir, f"{table}.queries.md")


async def _route_docs_for_table(
    table_meta: t.Dict[str, t.Any],
    docs: t.List[t.Dict[str, t.Any]],
    usage_acc: t.Dict[str, int],
    model: str,
) -> list[tuple[int, float]]:
  """Ask the router which docs are relevant to this table; return [(idx, score)]."""
  if not docs:
    return []
  table_block = kcmd_tools.flatten_table_for_prompt(table_meta, max_fields=80)
  catalog = "\n\n".join(f"[{d['id']}] {d['descriptor']}" for d in docs)
  prompt = (
      f"TARGET TABLE:\n{table_block}\n\n"
      f"CANDIDATE DOCUMENTS (numbered):\n{catalog}\n\n"
      "Return the JSON array of relevant documents for THIS table."
  )
  text = await common.run_text(create_router_runner(model), prompt, usage_acc)
  return _parse_router(text, len(docs))


# §6.4 cross-table context (v3). Cross-table facts (joins, metrics, source-of-
# truth/grain relationships) are extracted PER DOC during the summarization read
# (see create_doc_summarizer_runner + _split_descriptor_concepts), then merged
# here by _aggregate_concepts and injected into each table's prompt ONLY for the
# concepts that name it. This mirrors OKF's shared references/{joins,metrics}
# that every contributing table links to — but folds extraction into a read we
# already do (no separate full-corpus pass) and reconnects cross-doc facts in a
# cheap merge step.
SHARED_CONCEPT_INSTRUCTION = (
    "You consolidate CROSS-TABLE facts extracted from a dataset's documentation "
    "so each table's overview can include the relationships and metrics that "
    "involve it. Only merge or connect what the inputs state — never invent "
    "joins, keys, or formulas. Output STRICT JSON only, no prose."
)


async def _aggregate_concepts(docs, table_names, usage_acc):
  """Aggregate the per-doc cross-table concepts (already extracted during the
  summarization read) into the dataset's shared-concept list. Two steps:
    1. Deterministic dedup — collapse exact (kind, tables, title) repeats.
    2. ONE small flash merge pass over the COMPACT concept list (not full docs)
       to fold near-duplicates and CONNECT facts that only emerge across docs
       (e.g. one doc gives a join key, another names the table it joins to).
  Replaces the old full-corpus extraction call: same shared concepts, but the
  expensive whole-doc read is reused from summarization, so it's far cheaper."""
  raw = [c for d in docs for c in (d.get("concepts") or [])]
  if not raw:
    return []
  # 1. Deterministic dedup, keeping the most complete body.
  by_key = {}
  for c in raw:
    key = (c.get("kind", ""), tuple(sorted(c.get("tables", []))),
           (c.get("title", "") or "").strip().lower())
    prev = by_key.get(key)
    if prev is None or len(c.get("body", "")) > len(prev.get("body", "")):
      by_key[key] = c
  deduped = list(by_key.values())
  if len(deduped) <= 1:
    return deduped
  # 2. Small flash merge/connect pass (compact bullets, no doc bodies).
  listing = "\n".join(
      f"{i}. [{c['kind']}] tables={c['tables']} | {c['title']}: {c['body']}"
      for i, c in enumerate(deduped))
  prompt = (
      f"DATASET TABLES: {table_names}\n\nEXTRACTED CROSS-TABLE FACTS (one per"
      f" line, gathered from separate documents):\n{listing}\n\n"
      "Consolidate this list: (a) MERGE entries that state the same fact (keep"
      " the most complete wording, union their tables); (b) CONNECT facts that"
      " only emerge by combining entries — e.g. one names a join key and another"
      " names the table it joins to — into a single complete fact; (c) DROP an"
      " entry only if it is a pure duplicate. Do NOT invent any join, key, or"
      " formula not present above; do NOT add tables outside DATASET TABLES.\n"
      "Return STRICT JSON: {\"concepts\":[{\"kind\":...,\"tables\":[...],"
      "\"title\":...,\"body\":...}, ...]}."
  )
  text = await common.generate_text_direct(
      SHARED_CONCEPT_INSTRUCTION, prompt, _WRITER_MODEL, usage_acc)
  m = re.search(r"\{.*\}", text or "", re.S)
  try:
    obj = json.loads(m.group(0)) if m else {}
    merged = obj.get("concepts", []) if isinstance(obj, dict) else []
  except (ValueError, json.JSONDecodeError):
    merged = []
  out = []
  for c in merged:
    if not isinstance(c, dict):
      continue
    tabs = [str(t) for t in (c.get("tables") or []) if str(t) in table_names]
    body = (c.get("body") or "").strip()
    if tabs and body:
      out.append({"kind": str(c.get("kind", "")), "tables": tabs,
                  "title": (c.get("title") or "").strip(), "body": body})
  # Fallback: never lose facts if the merge pass returns nothing usable.
  return out or deduped


def build_shared_concept_block(shared_concepts, table_name) -> str:
  """Filter the dataset's aggregated shared concepts to those that name
  `table_name` and format them as prompt bullets (or "(none)").

  Bidirectional by design: a concept tagged `tables=[A, B]` is returned for BOTH
  A and B, so the relationship reaches a table even when the other table's
  per-table documents are the only ones that state it. Shared verbatim by table
  mode AND context-overlay/hybrid mode so the injection format never drifts (see
  `cross_table_context_section`)."""
  mine = [c for c in (shared_concepts or [])
          if table_name in (c.get("tables") or [])]
  if not mine:
    return "(none)"
  return "\n".join(
      f"- [{c['kind']}] {c['title']}: {c['body']}" for c in mine)


def cross_table_context_section(shared_block: str) -> str:
  """The additive CROSS-TABLE SHARED CONTEXT prompt section appended to a
  per-table writer prompt. `shared_block` is the output of
  `build_shared_concept_block`. Shared by table mode and
  context-overlay/hybrid mode so the wording (and its strict "additional, never
  drop a document fact" contract) stays identical across modes — this is v3's
  cross-table-concepts feature, now applied in every per-table writer."""
  return (
      "CROSS-TABLE SHARED CONTEXT"
      " (joins / metrics / source-of-truth & grain relationships that involve"
      " THIS table, distilled once from the dataset's docs — including"
      " relationships where ANOTHER table references THIS one, which the"
      " per-table documents above may not state). This is STRICTLY ADDITIONAL"
      " context: first cover everything the documents above support exactly as"
      " you would WITHOUT this block, then ADD the relevant cross-table facts"
      " on top — e.g. a `## Relationships` / `## Joins` section. NEVER drop,"
      " shorten, or omit a document-grounded fact to make room for these."
      " They are grounded; state them but do NOT invent beyond them, and do"
      f" NOT describe other tables for their own sake:\n"
      f"{shared_block}")


async def run(
    dataset: str,
    folders: list[str] | None,
    topic: str,
    output_dir: str | None,
    model: str,
    *,
    include_usage: bool = True,
    usage_window_days: int = 30,
    anonymize_users: bool = False,
    usage_scope: str = "auto",
    feedback_dir: str | None = None,
    feedback_files: list[str] | None = None,
    glossaries: list[str] | None = None,
    repo: str = "",
    repo_ref: str = "",
    repo_subdir: str = "",
    mcp_config: str = "",
    output_format: str = "kcmd",
    confluence_spaces: list[str] | None = None,
    confluence_cql: list[str] | None = None,
    confluence_page_ids: list[str] | None = None,
    sharepoint_sites: list[str] | None = None,
    sharepoint_search: list[str] | None = None,
    sharepoint_file_ids: list[str] | None = None,
):
  project, dataset_id = _parse_dataset(dataset)
  # --folder is a mixed list (Drive folders and/or local md dirs); each entry is
  # routed and id-extracted per entry inside _prepare_docs.
  folders = list(folders or [])
  # Load user-feedback proposals up front so per-table routing is cheap.
  # Empty list = no feedback path provided (or no proposals found); the
  # rest of the pipeline degrades to "no feedback" semantics naturally.
  all_feedback = feedback_tools.load_feedback(feedback_dir, feedback_files)

  print("=" * 60)
  print("=== ADK TABLE AGENT: Dataplex-Sourced, Folder-Grounded Enrichment ===")
  print(f"Topic: {topic}")
  print(f"Dataset: {project}.{dataset_id}  |  Folders: {folders or '(none)'}")
  if all_feedback:
    print(
        f"[Feedback] 📝 Loaded {len(all_feedback)} user-feedback"
        " proposal(s) — these will OVERRIDE conflicting context per table.",
        flush=True,
    )
  print(f"Glossaries: {glossaries or '(none — column linking disabled)'}")
  print("=" * 60)

  usage_acc = {"input": 0, "output": 0}
  if not output_dir:
    print(
        "[kcmd] ❌ output_dir is required (kcmd writes the snapshot there).",
        flush=True,
    )
    return

  # 1. Discover tables via kcmd — NO direct Dataplex API. Runs `kcmd init
  #    --bigquery-dataset <proj>.<dataset>`, writes a schema-declaring manifest,
  #    then `kcmd pull` -> catalog/<proj>.<dataset>/<table>.yaml with schema.
  #    (kcmd_tools echoes each real command it runs.)
  #
  # When `glossaries` is provided, the manifest also wires snapshot+publishing+
  # reference entryLinks so `kcmd pull` brings down existing column-level links
  # (used as few-shot governance context for the LinkingAgent below) and
  # `kcmd push` reconciles agent-added links to Dataplex.
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
      f"[kcmd] 🔎 Discovering {project}.{dataset_id} via kcmd init + pull"
      f"{' (with glossary links)' if glossary_scope else ''} ...",
      flush=True,
  )
  ok, msg = await asyncio.to_thread(
      kcmd_tools.init_pull_dataset,
      output_dir,
      project,
      dataset_id,
      bool(glossary_scope),
  )
  print(f"[kcmd] {'OK' if ok else '⚠️  FAILED'}: {msg}", flush=True)

  # Side-channel pull of glossary terms so the LinkingAgent's terms_context
  # is populated. This swaps catalog.yaml temporarily (kcmd_tools restores it).
  if glossary_scope:
    print(
        f"[kcmd] 🔎 Pulling glossary terms ({glossary_scope}) as reference ...",
        flush=True,
    )
    ok_g, msg_g = await asyncio.to_thread(
        kcmd_tools.pull_glossary_as_reference,
        output_dir,
        project,
        glossary_scope,
    )
    print(
        f"[kcmd] {'OK' if ok_g else '⚠️  FAILED'} (glossary reference):"
        f" {msg_g}",
        flush=True,
    )

  table_names = kcmd_tools.list_tables(output_dir, project, dataset_id)
  tables = [
      kcmd_tools.read_table_meta(output_dir, project, dataset_id, t)
      for t in table_names
  ]
  for meta in tables:
    print(
        f"[kcmd] 📑 {meta['table']} ({len(meta['schema_fields'])} cols)",
        flush=True,
    )

  if not tables:
    print(
        "[kcmd] ❌ No table entries pulled — nothing to enrich. "
        "Check the dataset id and that you can read its @bigquery entries.",
        flush=True,
    )
    return

  # 2a. Fetch + summarize the Drive folder + (in parallel) fetch BQ
  # query-history usage signals via INFORMATION_SCHEMA. The two are
  # independent (Drive API vs BigQuery API) so we overlap them to keep the
  # critical-path wall-clock identical to docs-only.
  if include_usage:
    print(
        f"[BQ Usage] 📊 Fetching query history (window={usage_window_days}d,"
        f" scope={usage_scope}) for {len(tables)} table(s)...",
        flush=True,
    )
    docs, usage_by_table = await asyncio.gather(
        _prepare_docs(topic, folders, usage_acc, model, table_names=[m["table"] for m in tables]),
        asyncio.to_thread(
            bq_usage_tools.fetch_dataset_usage,
            project,
            dataset_id,
            [m["table"] for m in tables],
            window_days=usage_window_days,
            anonymize_users=anonymize_users,
            scope=usage_scope,
        ),
    )
    n_with_signal = sum(
        1 for u in usage_by_table.values() if u.total_queries > 0
    )
    print(
        f"[BQ Usage] ✅ {n_with_signal}/{len(tables)} table(s) have usage"
        " signal in the window.",
        flush=True,
    )
  else:
    docs = await _prepare_docs(topic, folders, usage_acc, model, table_names=[m["table"] for m in tables])
    usage_by_table = {}
  # Source-code source (optional): explore a GitHub repo agentically and add its
  # component cards to the candidate-document pool. They are scored by the same
  # relevance router as Drive docs, so a code component that reads/writes a table
  # (or contains SQL referencing it) gets routed to that table and grounds its
  # overview + queries aspect. ids are reassigned to keep id == list position
  # (the router/writer index `docs` positionally).
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

  # Confluence corpus (optional): page cards join the relevance router's
  # candidate pool alongside Drive docs and code cards.
  conf_docs = await confluence_tools.gather_confluence_context(
      confluence_spaces,
      confluence_cql,
      confluence_page_ids,
      topic,
      model,
      usage_acc,
      mcp_config_path=mcp_config or None,
  )
  for d in conf_docs:
    d["_kind"] = "confluence"
  docs.extend(conf_docs)

  # SharePoint corpus (optional). Same router-descriptor doc shape.
  sp_docs = await sharepoint_tools.gather_sharepoint_context(
      sharepoint_sites,
      sharepoint_search,
      sharepoint_file_ids,
      topic,
      model,
      usage_acc,
  )
  for d in sp_docs:
    d["_kind"] = "sharepoint"
  docs.extend(sp_docs)

  for i, d in enumerate(docs):
    d["id"] = i

  if not docs:
    print(
        "[Folder] ⚠️  No folder/code content — tables will be documented from"
        " schema only.",
        flush=True,
    )

  # 3. Per-table routing — pick relevant folder docs for each table (existing).
  print(
      f"\n[Agent] 🧮 Routing folder docs to {len(tables)} table(s)...",
      flush=True,
  )
  sem = asyncio.Semaphore(CONCURRENCY_LIMIT)

  async def _route_one(meta):
    async with sem:
      selected = await _route_docs_for_table(meta, docs, usage_acc, model)
      label = (
          ", ".join(f"{docs[i]['name']} ({s:.2f})" for (i, s) in selected)
          or "(none — schema-only)"
      )
      print(f"[Router] {meta['table']} ← {label}", flush=True)
      return meta["table"], selected

  routing = dict(await asyncio.gather(*[_route_one(m) for m in tables]))

  # §6.4 fix (OKF-style): distill the dataset's cross-table facts ONCE into
  # structured shared concepts (joins/metrics/relationships), each tagged with
  # the tables it involves. Per-table routing silos each overview to its own
  # docs, so a cross-table fact the router scored for table A never reaches table
  # B even when it is about B; injecting the relevant shared concepts per table
  # fixes that without dumping raw other-table docs (which distracts the writer).
  print("[Agent] 🔗 Aggregating per-doc cross-table concepts...", flush=True)
  shared_concepts = await _aggregate_concepts(
      docs, [m["table"] for m in tables], usage_acc)
  print(f"[Agent] ✅ {len(shared_concepts)} shared concept(s).", flush=True)

  # 4. ENUMERATE — shared EnumerationAgent groups tables into categories.
  # Seed entries are the tables themselves; the agent only assigns categories.
  print(
      f"[Agent] 🧭 Categorizing {len(tables)} table(s) into themes...",
      flush=True,
  )
  enum_context_lines = [f"DATASET: {project}.{dataset_id}", ""]
  for meta in tables:
    sel = routing.get(meta["table"], [])
    sel_descs = [docs[i]["descriptor"][:400] for (i, _s) in sel[:5]]
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
      {"id": m["table"], "display_name": m["table"], "kind": "table"}
      for m in tables
  ]
  enumeration = await common.run_enumeration(
      topic,
      enum_context,
      seed_entries=seed_entries,
      model=model,
      usage_acc=usage_acc,
  )
  print(
      f"[Agent] ✅ {len(enumeration.categories)} categories: "
      f"{[(c.id, len(c.entries)) for c in enumeration.categories]}",
      flush=True,
  )
  cat_by_entry_id = {e.id: c for c in enumeration.categories for e in c.entries}

  # 5. WRITE — shared per-entry write fan-out (direct generate_content, v5 #4).
  from engine import ENTRY_WRITER_INSTRUCTION

  print(
      "[Agent] 🏗️  Writing per-table overviews via direct Flash (concurrency"
      f" {CONCURRENCY_LIMIT})...",
      flush=True,
  )
  sem2 = asyncio.Semaphore(CONCURRENCY_LIMIT)

  async def _write_one(meta):
    async with sem2:
      sel = routing.get(meta["table"], [])
      sel_docs = [docs[i] for (i, _s) in sel]
      cat = cat_by_entry_id.get(meta["table"])
      cat_id = cat.id if cat else "uncategorized"
      cat_title = cat.title if cat else "Uncategorized"
      # Per-table feedback routing. Proposals whose target_asset.name's
      # table-prefix matches this table apply here (TABLE targets match
      # directly; COLUMN targets strip the trailing column segment).
      table_fqn = f"{project}.{dataset_id}.{meta['table']}"
      table_feedback = feedback_tools.route_proposals_to_table(
          all_feedback, table_fqn
      )
      if table_feedback:
        print(
            f"[Feedback] 📝 {table_fqn}: {len(table_feedback)} proposal(s)"
            " applied — these OVERRIDE conflicting context.",
            flush=True,
        )
      if sel_docs:
        context = "\n\n".join(
            f"--- DOCUMENT: {d['name']} ({d['url']})"
            f" ---\n{d['content'][:MAX_DOC_CHARS]}"
            for d in sel_docs
        )
      else:
        context = "(none — document this table from its schema/metadata only)"
      # §6.4 (OKF-style): inject ONLY the shared concepts that name THIS table.
      # Shared helper so table / context-overlay / hybrid all build this block
      # identically (build_shared_concept_block + cross_table_context_section).
      shared_block = build_shared_concept_block(shared_concepts, meta["table"])
      table_block = kcmd_tools.flatten_table_for_prompt(meta)
      # Table-mode-specific directive on top of the shared writer
      # instruction: any SQL example we find in the docs belongs in the
      # `queries` aspect (handled separately by extract_doc_queries +
      # the queries sidecar), NOT inlined in the overview body. Without
      # this, the writer routinely embeds ```sql blocks in the overview
      # which then get pushed as part of the overview aspect content and
      # duplicate what's in the queries aspect.
      table_mode_directive = (
          "\n\nIMPORTANT — TABLE MODE: Do NOT include any SQL query"
          " examples in the overview body (no ```sql blocks, no inline"
          " queries). SQL examples are captured separately in this entry's"
          " `queries` aspect by another pipeline step. The overview should"
          " describe WHAT the table is and HOW it's used in narrative"
          " prose, while leaving the runnable SQL to the queries aspect."
      )
      # Feedback block carries the OVERRIDE directive + instructs the
      # writer to surface a "## User Corrections" section near the top
      # of the overview. Empty string when no feedback applies to this
      # table, so the concatenation is a no-op then.
      feedback_block = feedback_tools.proposals_to_prompt_block(table_feedback)
      prompt = (
          f"TOPIC: {topic}\n\nENTRY CANONICAL NAME: {meta['table']}\nENTRY ID:"
          f" {meta['table']}\nCATEGORY: {cat_title} ({cat_id})\nALIASES:"
          " (none)\nDESCRIPTION: BigQuery table"
          f" {project}.{dataset_id}.{meta['table']}\nPRIMARY SOURCE URLS:\n"
          + ("\n".join(f"  - {d['url']}" for d in sel_docs) or "  (none)")
          + "\n\nTARGET TABLE METADATA (from kcmd"
          f" snapshot):\n{table_block}\n\nRELEVANT CONTEXT DOCUMENTS (routed"
          f" for this table only):\n{context}\n\n"
          + cross_table_context_section(shared_block)
          + "\n\nWrite the overview Markdown"
          " body for this table now."
          + table_mode_directive
          + feedback_block
      )
      body = await common.generate_text_direct(
          ENTRY_WRITER_INSTRUCTION, prompt, _WRITER_MODEL, usage_acc
      )
      written = _write_table_files(output_dir, project, dataset_id, meta, body)
      # Merge INFORMATION_SCHEMA-derived patterns + SQL examples extracted
      # from the routed docs + user-feedback golden_sql payloads into a
      # single `<table>.queries.md` aspect sidecar. Each is attributed in
      # the description prefix (`[Source: INFORMATION_SCHEMA]`,
      # `[Source: Documentation]`, or `[Source: User Feedback]`); the
      # aspect's `source` enum is AGENT for the first two and USER for
      # the feedback-derived entries (proto schema is closed enum).
      usage = usage_by_table.get(meta["table"]) if usage_by_table else None
      feedback_queries = feedback_tools.proposals_to_queries(table_feedback)
      if (usage or feedback_queries) and output_dir:
        # Use an empty TableUsage as the floor so the sidecar writer
        # doesn't crash when INFORMATION_SCHEMA wasn't reachable but
        # feedback supplied SQL.
        if usage is None:
          usage = bq_usage_tools.TableUsage(window_days=usage_window_days)
        doc_queries = await extract_doc_queries(
            meta, sel_docs, project, dataset_id, model, usage_acc
        )
        queries_path = write_queries_sidecar(
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
              f"[DocQueries] {meta['table']}: {len(doc_queries)} doc-extracted"
              f" + {len(feedback_queries)} user-feedback SQL example(s)",
              flush=True,
          )
      # Inject category into the kcmd-pulled entry YAML (top-level field;
      # kcmd ignores unknown fields, downstream consumers can group by it).
      if cat and output_dir:
        _inject_category(output_dir, project, dataset_id, meta["table"], cat.id)
      print(
          f"[Agent] ✅ {cat_id}/{meta['table']}: wrote {', '.join(written)}",
          flush=True,
      )
      # Capture per-entry state for multi-turn refinement (reuses `prompt`, so
      # docs are never re-read). overview_path is the sidecar a refinement
      # overwrites — the same file _write_table_files just wrote.
      entry_state = refine.EntryState(
          entry_id=meta["table"],
          display_name=meta["table"],
          description=meta.get("description", "") or "",
          category_id=cat_id,
          grounding_prompt=prompt,
          writer_model=_WRITER_MODEL,
          overview_body=body,
          overview_path=os.path.join(
              kcmd_tools._dataset_dir(output_dir, project, dataset_id),
              f"{meta['table']}.overview.md",
          ),
          kind="table",
      )
      return meta, sel_docs, body, entry_state

  results = await asyncio.gather(*[_write_one(m) for m in tables])

  # 5b. Optional glossary column-linking: when --glossaries was provided,
  # run the LinkingAgent over each table and inject column->term mappings
  # into the same <table>.yaml that overview generation just enriched. Kept
  # AFTER overview gen so token usage and trajectory both reflect the full
  # enrichment pass.
  if glossary_scope:
    import linking  # local import to avoid cycle at module load

    print("[Linking] 🔗 Mapping columns to glossary terms ...", flush=True)
    n_links = await linking.apply_column_linking(
        output_dir, project, dataset_id, model, usage_acc
    )
    print(f"[Linking] ✅ Injected {n_links} column link(s) total.", flush=True)

  # 6. Persist trajectory for dynamic eval (mirrors doc mode). Records the
  # tables, their routed docs, AND the enumeration so eval can ground scoring.
  if output_dir:
    # Per-source fetches first (fetch_gdoc/read_local_md/explore_repo) — same
    # recording doc mode does — so eval counts tool calls consistently and
    # grounds hallucination on clean per-doc content. route_docs below keeps only
    # the routing (name/url), not content, to avoid duplicating it.
    tool_uses, tool_responses = common.doc_tool_calls(docs)
    tool_uses.extend(
        {"name": "get_table_entry", "args": {"table": m["table"]}}
        for m in tables
    )
    tool_responses.extend(
        {
            "name": "get_table_entry",
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
    common.write_trajectory(
        output_dir,
        "table",
        f"TOPIC: {topic} | DATASET: {project}.{dataset_id}",
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
  return refine.EnrichmentSession(
      mode="table",
      topic=topic,
      model=model,
      output_dir=output_dir,
      entries={es.entry_id: es for (_m, _d, _t, es) in results},
      usage_acc=usage_acc,
      # Phase-2 state for a `reenumerate` refinement. Table entries are pinned
      # 1:1 to the dataset's tables, so re-enumeration here only re-categorizes
      # (it cannot add/remove entries) — see apply_reenumeration below.
      enum_context=enum_context,
      writer_params={"project": project, "dataset_id": dataset_id},
      traj_meta={
          "agent_type": "table",
          "user_input": f"TOPIC: {topic} | DATASET: {project}.{dataset_id}",
          "tool_uses": tool_uses if output_dir else [],
          "tool_responses": tool_responses if output_dir else [],
      },
  )


async def apply_reenumeration(session, new_enum, removed_ids) -> None:
  """Materialize a table-mode re-enumeration delta — re-categorization ONLY.

  Table entries are pinned 1:1 to the dataset's tables, so a re-enumeration
  can neither add a topic (no underlying table) nor remove one (the table still
  exists). We therefore ignore additions/removals and apply only category
  changes: rewrite the `category:` field on the kcmd-pulled entry YAML (files
  stay under `catalog/{proj}.{dataset}/`, so no move). Mutates session.entries.
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
        "[refine] ℹ️  table mode: entries are pinned to the dataset — cannot"
        f" remove {sorted(set(removed_ids))}; applying category changes only.",
        flush=True,
    )
  for eid, es in session.entries.items():
    cat = new_cat_by_id.get(eid)
    if cat is None or cat.id == es.category_id:
      continue
    _inject_category(output_dir, project, dataset_id, eid, cat.id)
    es.category_id = cat.id
    print(f"[refine] 🔀 recategorized {eid} -> {cat.id}", flush=True)


def _inject_category(
    output_dir: str, project: str, dataset_id: str, table: str, category_id: str
):
  """Add `category: <id>` to the top of the kcmd-pulled entry YAML."""
  path = os.path.join(
      kcmd_tools._dataset_dir(output_dir, project, dataset_id),  # pylint: disable=protected-access
      f"{table}.yaml",
  )
  if not os.path.exists(path):
    return
  try:
    with open(path) as f:
      data = yaml.safe_load(f) or {}
    data["category"] = category_id
    with open(path, "w") as f:
      yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
  except (OSError, yaml.YAMLError):
    pass


# Flash for the per-table writer: small inputs (one table + a few docs) stay
# well under the ADK 32K Flash routing cap. Pro is still the user-supplied
# --model and is used by the enumerator (which needs reasoning across all tables).
_WRITER_MODEL = os.environ.get("KC_LIGHT_MODEL", "gemini-2.5-flash")
