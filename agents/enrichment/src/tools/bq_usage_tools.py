"""BigQuery query-history "usage signals" for kc_v2 table-mode enrichment.

For each table in a dataset, pull recent queries from
`region-<R>.INFORMATION_SCHEMA.JOBS_BY_PROJECT` (with `JOBS_BY_USER` fallback
when the caller lacks `bigquery.jobs.listAll`) and aggregate them into a
compact, prompt-ready "TableUsage" — top users, top normalized query patterns,
frequent join partners, most-referenced columns.

The design decisions baked in here:

1. **One batched query per dataset, not per table.** The job-history views
   scan by partition (`creation_time`) regardless of how many tables we
   filter to; firing 14 separate queries for a 14-table dataset costs ~14×
   the BQ scan for the same data. We fetch once, group by client-side.
2. **Cache the whole dataset's usage** at
   `~/.kc_enrich_cache/usage/<project>.<dataset>.json` keyed on
   (`project.dataset`, `YYYY-MM-DD`). Same-day re-runs are free.
3. **Strip literals** from query text before caching or surfacing to the
   LLM — defense-in-depth against PII / business-logic leakage.
4. **Snapshot-table fast path is deliberately NOT implemented in v1**
   per user direction; the env var name is reserved for the v2 follow-up.
"""

import dataclasses
import datetime as _dt
import hashlib
import json
import os
import re
import typing as t

# --- Config / env --------------------------------------------------------

# Reuse the same cache root + mode flag as drive_tools / engine summaries so
# users have a single knob (`KC_ENRICH_CACHE_MODE`) and a single dir
# (`~/.kc_enrich_cache/`, chmod 700) to reason about.
_CACHE_DIR = os.path.join(os.environ.get("HOME", "/tmp"), ".kc_enrich_cache")
_USAGE_CACHE_DIR = os.path.join(_CACHE_DIR, "usage")

# Reserved for the v2 snapshot-table fast path. Reading it now (even though
# unused) keeps the env-var name stable across versions.
_SNAPSHOT_TABLE_ENV = "KC_ENRICH_USAGE_SNAPSHOT_TABLE"

_DEFAULT_WINDOW_DAYS = 30
# Per-table aggregate caps — keep the surfaced signal compact enough to fit
# in the writer prompt alongside schema + Drive context without blowing the
# Pro context budget.
_MAX_TOP_USERS = 5
_MAX_TOP_PATTERNS = 3
_MAX_TOP_JOIN_PARTNERS = 5
_MAX_TOP_COLUMNS = 10


def _resolve_cache_mode() -> str:
  """Mirror drive_tools._resolve_cache_mode so usage cache obeys the same flag.

  Importing from drive_tools would create a cycle in some embedding contexts;
  we duplicate the (tiny) resolver to stay decoupled.

  Returns:
    Cache mode string.
  """
  legacy = os.environ.get("KC_ENRICH_CACHE", "").lower()
  if legacy in ("off", "0", "false", "no"):
    return "off"
  mode = os.environ.get("KC_ENRICH_CACHE_MODE", "").lower().strip()
  if mode in ("off", "raw", "summary"):
    return mode
  return "summary"


# --- Data shape ----------------------------------------------------------


@dataclasses.dataclass
class TableUsage:
  """Aggregated query-history signal for ONE table over a fixed window.

  Empty `total_queries` + scope='unavailable' means we tried and got
  nothing usable (no perm, no jobs, or the table isn't referenced in the
  window) — callers SHOULD render "(no usage observed)" rather than
  fabricating a paragraph.
  """

  total_queries: int = 0
  total_bytes_processed: int = 0
  top_users: t.List[t.Any] = dataclasses.field(default_factory=list)
  top_query_patterns: t.List[t.Any] = dataclasses.field(default_factory=list)
  top_join_partners: t.List[t.Any] = dataclasses.field(default_factory=list)
  top_referenced_columns: t.List[t.Any] = dataclasses.field(
      default_factory=list
  )
  # 'snapshot' | 'project' | 'user' | 'unavailable'
  scope: str = "unavailable"
  window_days: int = _DEFAULT_WINDOW_DAYS
  fetched_at: str = ""


def _empty(window_days: int) -> TableUsage:
  """Returns an empty TableUsage.

  Args:
    window_days: Window days.

  Returns:
    Empty TableUsage.
  """
  return TableUsage(window_days=window_days, fetched_at=_now_iso())


def _now_iso() -> str:
  """Returns current time in ISO format.

  Returns:
    ISO time string.
  """
  return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


# --- Literal stripper ----------------------------------------------------

# Normalize query text so different queries with the same shape collapse to
# the same pattern. Regex-based; covers strings, numerics, IN-lists, and
# common date literals — the 80% case. For SQL with unusual literal shapes
# the pattern just collapses less aggressively, which only weakens
# aggregation (not correctness).
_LITERAL_PATTERNS = [
    (re.compile(r"'(?:[^']|'')*'"), "{STR}"),
    (re.compile(r'"(?:[^"]|"")*"'), "{STR}"),
    (re.compile(r"\bDATE\s*'[^']*'", re.IGNORECASE), "{DATE}"),
    (re.compile(r"\bTIMESTAMP\s*'[^']*'", re.IGNORECASE), "{TS}"),
    (
        re.compile(r"\bIN\s*\(\s*(?:[^()]|\([^()]*\))*\)", re.IGNORECASE),
        "IN ({LIT_LIST})",
    ),
    (re.compile(r"\b\d+\.\d+\b"), "{NUM}"),
    (re.compile(r"\b\d+\b"), "{NUM}"),
]

# Collapse whitespace AFTER literal stripping so patterns dedupe cleanly.
_WS_RE = re.compile(r"\s+")


def normalize_query(sql: str) -> str:
  """Strip literals + collapse whitespace.

  Used for pattern grouping AND for the prompt-surfaced sample, so the LLM never
  sees raw user data.

  Args:
    sql: Raw SQL query.

  Returns:
    Normalized SQL query.
  """
  if not sql:
    return ""
  out = sql.strip()
  for pat, replacement in _LITERAL_PATTERNS:
    out = pat.sub(replacement, out)
  return _WS_RE.sub(" ", out).strip()


def _hash_user(email: str) -> str:
  """One-way hash for --anonymize-users mode.

  Stable across days so the same user shows the same hash in different runs
  (helps the LLM recognize recurring callers without revealing emails).

  Args:
    email: User email.

  Returns:
    Hashed user string.
  """
  return "user_" + hashlib.sha256(email.encode("utf-8")).hexdigest()[:10]


# --- Cache ---------------------------------------------------------------


def _cache_path(project: str, dataset: str) -> str:
  """Returns the cache path.

  Args:
    project: Project ID.
    dataset: Dataset ID.

  Returns:
    Cache path string.
  """
  safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{project}.{dataset}")[:200]
  return os.path.join(_USAGE_CACHE_DIR, f"{safe}.json")


def _today() -> str:
  """Returns today's date in ISO format.

  Returns:
    Today's date string.
  """
  return _dt.date.today().isoformat()


def _read_usage_cache(
    project: str, dataset: str, window_days: int
) -> t.Optional[t.Dict[str, t.Any]]:
  """Return cached `{table_id: TableUsage-as-dict}` if fresh, else None.

  Stale = different day OR different window_days. Treating window as part
  of the key prevents a 7-day cached fetch from serving a 30-day request.

  Args:
    project: Project ID.
    dataset: Dataset ID.
    window_days: Window days.

  Returns:
    Cached usage dict or None.
  """
  if _resolve_cache_mode() == "off":
    return None
  path = _cache_path(project, dataset)
  if not os.path.exists(path):
    return None
  try:
    with open(path) as f:
      blob = json.load(f)
  except (OSError, json.JSONDecodeError):
    return None
  if blob.get("day") != _today() or blob.get("window_days") != window_days:
    return None
  return blob.get("tables") or {}


def _write_usage_cache(
    project: str,
    dataset: str,
    window_days: int,
    tables: t.Dict[str, TableUsage],
):
  """Writes usage cache.

  Args:
    project: Project ID.
    dataset: Dataset ID.
    window_days: Window days.
    tables: Dict of TableUsage.
  """
  if _resolve_cache_mode() == "off":
    return
  try:
    os.makedirs(_USAGE_CACHE_DIR, exist_ok=True)
    # Tighten the cache root once on every write — same hardening as
    # drive_tools, in case the dir was created by some other path.
    os.chmod(_CACHE_DIR, 0o700)
  except OSError:
    pass
  blob = {
      "day": _today(),
      "window_days": window_days,
      "tables": {tid: dataclasses.asdict(u) for tid, u in tables.items()},
  }
  tmp = _cache_path(project, dataset) + ".tmp"
  try:
    with open(tmp, "w") as f:
      json.dump(blob, f)
    os.replace(tmp, _cache_path(project, dataset))
  except OSError:
    try:
      os.remove(tmp)
    except OSError:
      pass


# --- Dataset region lookup -----------------------------------------------


def get_dataset_region(project: str, dataset: str) -> str | None:
  """Return the lowercased region of a dataset (e.g. 'us', 'us-central1').

  Needed because `JOBS_BY_*` is regional — querying the wrong region
  returns zero rows silently. Returns None on permission/lookup failure,
  in which case the caller should fall back to the default region 'us'
  (the most common location for our test corpora).

  Args:
    project: Project ID.
    dataset: Dataset ID.

  Returns:
    Region string or None.
  """
  try:
    from google.cloud import bigquery  # pylint: disable=g-import-not-at-top
  except ImportError:
    return None
  try:
    client = bigquery.Client(project=project)
    ds = client.get_dataset(f"{project}.{dataset}")
    loc = (ds.location or "").lower()
    return loc or None
  except Exception:  # pylint: disable=broad-except
    return None


# --- Batched fetch -------------------------------------------------------

# One INFO_SCHEMA query per dataset: the EXISTS clause limits returned rows
# to jobs that touched any table in the dataset. Python aggregates per
# `referenced_tables.table_id` from the result. `creation_time` is the
# partition key on these views; the date filter prunes scan to the window.
_JOBS_SQL_TEMPLATE = """
SELECT
  job_id,
  user_email,
  query,
  total_bytes_processed,
  creation_time,
  referenced_tables
FROM `region-{region}`.INFORMATION_SCHEMA.{jobs_view}
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @window_days DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
  AND EXISTS (
    SELECT 1 FROM UNNEST(referenced_tables) rt
    WHERE rt.project_id = @project AND rt.dataset_id = @dataset
  )
"""


def _run_jobs_query(
    project: str,
    dataset: str,
    region: str,
    window_days: int,
    use_user_scope: bool,
):
  """Yield (job_id, user_email, query, total_bytes, creation_time, referenced_tables).

  tuples. Raises on permission / SQL errors; caller decides whether to fall
  back.

  Args:
    project: Project ID.
    dataset: Dataset ID.
    region: Region.
    window_days: Window days.
    use_user_scope: Whether to use JOBS_BY_USER.

  Yields:
    Row data.
  """
  from google.cloud import bigquery  # pylint: disable=g-import-not-at-top

  view = "JOBS_BY_USER" if use_user_scope else "JOBS_BY_PROJECT"
  sql = _JOBS_SQL_TEMPLATE.format(region=region, jobs_view=view)
  client = bigquery.Client(project=project)
  job_config = bigquery.QueryJobConfig(
      query_parameters=[
          bigquery.ScalarQueryParameter("window_days", "INT64", window_days),
          bigquery.ScalarQueryParameter("project", "STRING", project),
          bigquery.ScalarQueryParameter("dataset", "STRING", dataset),
      ]
  )
  for row in client.query(sql, job_config=job_config).result():
    yield row


def _aggregate(
    rows,
    table_ids: t.List[str],
    project: str,
    dataset: str,
    anonymize_users: bool,
    window_days: int,
) -> t.Dict[str, TableUsage]:
  """Group raw rows by (referenced_tables.table_id) → TableUsage.

  Each row may contribute to multiple tables (a join over two of our tables
  shows up in both buckets) — that's the intended semantics.

  Args:
    rows: Rows to aggregate.
    table_ids: Table IDs.
    project: Project ID.
    dataset: Dataset ID.
    anonymize_users: Whether to anonymize users.
    window_days: Window days.

  Returns:
    Dict of TableUsage.
  """
  table_set = set(table_ids)
  # Per-table accumulators
  buckets: t.Dict[str, t.Dict[str, t.Any]] = {
      tid: {
          "queries": 0,
          "bytes": 0,
          "users": {},
          "patterns": {},
          "join_partners": {},
          "columns": {},
      }
      for tid in table_ids
  }
  for row in rows:
    refs = (
        row.get("referenced_tables")
        if isinstance(row, dict)
        else (row.referenced_tables or [])
    )
    # Convert BQ Row objects to plain dicts for uniform access.
    ref_list = []
    for r in refs:
      r_dict = dict(r) if hasattr(r, "items") else r
      ref_list.append(r_dict)
    # Identify which of OUR tables this job touched.
    touched_here = [
        r["table_id"]
        for r in ref_list
        if r.get("project_id") == project
        and r.get("dataset_id") == dataset
        and r.get("table_id") in table_set
    ]
    if not touched_here:
      continue
    user = row.user_email or ""
    user_key = _hash_user(user) if anonymize_users and user else user
    norm = normalize_query(row.query or "")
    bytes_ = int(row.total_bytes_processed or 0)
    # Other (non-bucket) tables this job touched → join partners
    other_partners = [
        f"{r['project_id']}.{r['dataset_id']}.{r['table_id']}"
        for r in ref_list
        if r.get("table_id") not in touched_here
        or r.get("dataset_id") != dataset
        or r.get("project_id") != project
    ]
    for tid in touched_here:
      b = buckets[tid]
      b["queries"] += 1
      b["bytes"] += bytes_
      if user_key:
        b["users"][user_key] = b["users"].get(user_key, 0) + 1
      if norm:
        b["patterns"][norm] = b["patterns"].get(norm, 0) + 1
      for partner in other_partners:
        b["join_partners"][partner] = b["join_partners"].get(partner, 0) + 1
      # Column-level signal — only available in `referenced_tables.columns`
      # for jobs where the query was column-pruned; fall back to nothing.
      for r in ref_list:
        if (
            r.get("project_id") == project
            and r.get("dataset_id") == dataset
            and r.get("table_id") == tid
        ):
          for col in r.get("columns", []) or []:
            cname = col if isinstance(col, str) else col.get("name", "")
            if cname:
              b["columns"][cname] = b["columns"].get(cname, 0) + 1

  scope = "project"  # set by caller
  fetched = _now_iso()
  out: t.Dict[str, TableUsage] = {}
  for tid, b in buckets.items():
    out[tid] = TableUsage(
        total_queries=b["queries"],
        total_bytes_processed=b["bytes"],
        top_users=_topn(b["users"], _MAX_TOP_USERS),
        top_query_patterns=_topn(b["patterns"], _MAX_TOP_PATTERNS),
        top_join_partners=_topn(b["join_partners"], _MAX_TOP_JOIN_PARTNERS),
        top_referenced_columns=_topn(b["columns"], _MAX_TOP_COLUMNS),
        scope=scope,
        window_days=window_days,
        fetched_at=fetched,
    )
  return out


def _topn(counter: t.Dict[str, int], n: int) -> t.List[t.Any]:
  """Return [(key, count)] sorted by count desc, truncated to n.

  Stable on ties.

  Args:
    counter: Counter dict.
    n: Top N.

  Returns:
    List of top N items.
  """
  return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:n]


# --- Public entrypoint ---------------------------------------------------


def fetch_dataset_usage(
    project: str,
    dataset: str,
    table_ids: t.List[str],
    *,
    window_days: int = _DEFAULT_WINDOW_DAYS,
    anonymize_users: bool = False,
    region: str | None = None,
    scope: str = "auto",
) -> t.Dict[str, TableUsage]:
  """Pull aggregated query-history usage for a dataset's tables.

  Strategy:
    1. Honor the daily cache at ~/.kc_enrich_cache/usage/.
    2. (Reserved) Snapshot-table fast path — currently a no-op; the
       KC_ENRICH_USAGE_SNAPSHOT_TABLE env var is read but the path is
       deliberately not yet implemented (v2 step function per design doc).
    3. JOBS_BY_PROJECT (rich) — try first when scope=='auto' or 'project'.
    4. JOBS_BY_USER (narrow) — fall back to on Forbidden / NotFound, or
       use directly when scope=='user'.

  Returns `{table_id: TableUsage}`. Tables with no observed queries get
  an empty `TableUsage(scope='unavailable')` — callers should render a
  graceful "no usage observed" rather than fabricating signal.

  Failure modes (network down, bq client missing, region lookup fails)
  all return empty results rather than raising — the writer prompt then
  just omits the usage section.

  Args:
    project: Project ID.
    dataset: Dataset ID.
    table_ids: Table IDs.
    window_days: Window days.
    anonymize_users: Whether to anonymize users.
    region: Region.
    scope: Scope string.

  Returns:
    Dict of TableUsage.
  """
  cached = _read_usage_cache(project, dataset, window_days)
  if cached is not None:
    return _hydrate_cached(cached, table_ids, window_days)

  # Snapshot-table path reserved for v2 step function — for now we only
  # log when the env var is set so users know we saw it.
  snapshot_table = os.environ.get(_SNAPSHOT_TABLE_ENV, "").strip()
  if snapshot_table:
    print(
        f"[bq_usage] note: {_SNAPSHOT_TABLE_ENV} is set ({snapshot_table})"
        " but the snapshot fast path isn't implemented yet — falling"
        " through to INFORMATION_SCHEMA. Tracked as v2 step function.",
        flush=True,
    )

  region = (region or get_dataset_region(project, dataset) or "us").lower()
  results = {tid: _empty(window_days) for tid in table_ids}
  try_user_scope = scope == "user"

  if scope in ("auto", "project") and not try_user_scope:
    try:
      rows = list(
          _run_jobs_query(
              project, dataset, region, window_days, use_user_scope=False
          )
      )
      results = _aggregate(
          rows, table_ids, project, dataset, anonymize_users, window_days
      )
      for tid in results:
        if results[tid].total_queries > 0 or scope == "project":
          results[tid].scope = "project"
      _write_usage_cache(project, dataset, window_days, results)
      return results
    except Exception as e:  # pylint: disable=broad-except
      # Permission-denied on bigquery.jobs.listAll is the most common case;
      # fall back to user scope. Other failures (region typo, billing
      # disabled) also fall through, but those won't be helped by the
      # fallback either — they just return empty.
      print(
          f"[bq_usage] JOBS_BY_PROJECT failed ({type(e).__name__}: {e!s:.180});"
          " falling back to JOBS_BY_USER",
          flush=True,
      )
      try_user_scope = True

  if try_user_scope or scope == "user":
    try:
      rows = list(
          _run_jobs_query(
              project, dataset, region, window_days, use_user_scope=True
          )
      )
      results = _aggregate(
          rows, table_ids, project, dataset, anonymize_users, window_days
      )
      for tid in results:
        results[tid].scope = "user"
      _write_usage_cache(project, dataset, window_days, results)
      return results
    except Exception as e:  # pylint: disable=broad-except
      print(
          f"[bq_usage] JOBS_BY_USER also failed ({type(e).__name__}: "
          f"{e!s:.180}); returning empty usage",
          flush=True,
      )

  return results


def _hydrate_cached(
    cached: t.Dict[str, t.Any], table_ids: t.List[str], window_days: int
) -> t.Dict[str, TableUsage]:
  """Build a {table_id: TableUsage} dict from cached JSON, defaulting any.

  table not in the cache to an empty TableUsage. Lets us add a new table
  to a dataset mid-day without busting the entire cache.

  Args:
    cached: Cached dict.
    table_ids: Table IDs.
    window_days: Window days.

  Returns:
    Dict of TableUsage.
  """
  out: t.Dict[str, TableUsage] = {}
  for tid in table_ids:
    raw = cached.get(tid)
    if raw:
      out[tid] = TableUsage(**raw)
    else:
      out[tid] = _empty(window_days)
  return out


# --- Prompt-surface formatter --------------------------------------------


def format_usage_section(usage: TableUsage, table_fqn: str) -> str:
  """Render TableUsage as a Markdown section the writer prompt can ingest.

  Kept for callers that want a flat narrative — the table_mode sidecar
  writer now uses `format_queries_sidecar` instead, which produces a
  kcmd-style sidecar conforming to the `queries` aspect type
  (cloud/dataplex/catalog/types/aspect-types/queries.textproto).

  Args:
    usage: TableUsage.
    table_fqn: Table FQN.

  Returns:
    Formatted Markdown string.
  """
  if usage.total_queries == 0:
    return (
        "## Observed Usage\n\n"
        f"_(No usage observed for `{table_fqn}` in the last"
        f" {usage.window_days} days, or query-history access is"
        " unavailable.)_\n"
    )
  lines = [
      "## Observed Usage",
      "",
      (
          f"_Last {usage.window_days} days · scope: {usage.scope} · "
          f"fetched {usage.fetched_at}_"
      ),
      "",
      (
          f"- **{usage.total_queries} queries** ·"
          f" **{_human_bytes(usage.total_bytes_processed)} processed**"
      ),
  ]
  if usage.top_users:
    rendered = ", ".join(f"{u} ({n})" for u, n in usage.top_users)
    lines.append(f"- **Top users:** {rendered}")
  if usage.top_query_patterns:
    lines.append("- **Top query patterns:**")
    for pat, n in usage.top_query_patterns:
      lines.append(f"    - ({n}×) `{_truncate(pat, 240)}`")
  if usage.top_join_partners:
    rendered = ", ".join(f"{p} ({n})" for p, n in usage.top_join_partners)
    lines.append(f"- **Frequently joined with:** {rendered}")
  if usage.top_referenced_columns:
    rendered = ", ".join(
        f"`{c}` ({n})" for c, n in usage.top_referenced_columns
    )
    lines.append(f"- **Most-referenced columns:** {rendered}")
  return "\n".join(lines) + "\n"


# YAML serializer note: we hand-emit a small, well-controlled subset rather
# than pull in PyYAML's full dumper, so the frontmatter looks identical
# across Python versions and we can use block-scalars (`|`) for SQL bodies
# without depending on PyYAML's default_flow_style heuristics. The shape
# matches the Dataplex `queries` aspect type (`dataplex-types.global.queries`).

_JOB_NAME = "kc_v2_table_mode_enrichment"


def _yaml_escape_scalar(s: str) -> str:
  r"""Minimal escaping for a single-line YAML string value.

  Wraps in double quotes and backslash-escapes embedded `"` and `\\`.

  Args:
    s: Input string.

  Returns:
    Escaped string.
  """
  s = s.replace("\\", "\\\\").replace('"', '\\"')
  return f'"{s}"'


def _yaml_block_sql(sql: str, indent: int) -> str:
  """Emit `sql` as a YAML block scalar (`|`) so newlines + special chars.

  in the query body don't need quoting.

  Args:
    sql: SQL string.
    indent: Indent level.

  Returns:
    YAML block string.
  """
  pad = " " * indent
  lines = [f"{pad}{line}" if line else pad.rstrip() for line in sql.split("\n")]
  return "|\n" + "\n".join(lines)


def format_queries_sidecar(
    usage: TableUsage,
    table_fqn: str,
    *,
    doc_queries: t.Optional[t.List[t.Dict[str, t.Any]]] | None = None,
    feedback_queries: t.Optional[t.List[t.Dict[str, t.Any]]] | None = None,
) -> str:
  """Render the `queries` aspect sidecar for a single table.

  Three sources merge into one sidecar:
    1. `usage.top_query_patterns` — normalized patterns observed in
       INFORMATION_SCHEMA.JOBS_BY_PROJECT. Each gets a description
       prefix `[Source: INFORMATION_SCHEMA]`.
    2. `doc_queries` (optional) — `{description, sql}` dicts extracted
       from routed documentation by `_extract_doc_queries`. Each gets a
       description prefix `[Source: Documentation]`.
    3. `feedback_queries` (optional) — `{description, sql}` dicts
       sourced from direct user feedback (eval_candidate.golden_sql
       payloads via feedback_tools.proposals_to_queries). Each gets a
       description prefix `[Source: User Feedback]` AND the aspect's
       `source` enum is set to USER (not AGENT) — these queries are
       ground-truth user input, not LLM inference.

  The aspect type's `source` enum is closed (AGENT | USER) per the Dataplex
  `queries` aspect type schema (`dataplex-types.global.queries`);
  the prefix in the description disambiguates the AGENT-sourced entries
  further (INFORMATION_SCHEMA vs Documentation).

  YAML frontmatter ONLY (no body): kcmd's patched standard layout
  (toolbox/mdcode/src/libts/layouts/standard.ts) skips `content`
  injection when the body is empty, which keeps Dataplex push happy
  (the queries aspect has no `content` field).

  Args:
    usage: TableUsage.
    table_fqn: Table FQN.
    doc_queries: SQL extracted from routed documentation (AGENT source).
    feedback_queries: SQL from user-feedback proposals (USER source).

  Returns:
    Formatted YAML string.
  """
  # job.runTime: when THIS agent run wrote the aspect, NOT when the
  # underlying BQ sample was taken. The daily usage cache means
  # `usage.fetched_at` can be hours stale by the time we write the aspect,
  # which made re-pushes within the same day look like no-ops at the
  # aspect-data level (even though Dataplex's server-side aspect.updateTime
  # did advance). Using _now_iso() keeps job.runTime semantically aligned
  # with `aspect.updateTime` — a stale BQ sample is a separate concern
  # already encoded by the per-query description (`Observed N× in last
  # window_days days`).
  run_time = _now_iso()
  doc_queries = doc_queries or []
  feedback_queries = feedback_queries or []

  # Build the frontmatter as a deterministic YAML string.
  fm_lines = ["---", "queries:"]

  # User-feedback entries emit FIRST so they're the most prominent in the
  # rendered aspect — these are ground truth from real user interactions
  # and outrank everything else when readers scan the queries.
  for q in feedback_queries:
    raw_desc = (q.get("description") or "").strip()
    if not raw_desc:
      raw_desc = "User-feedback query example."
    desc = f"[Source: User Feedback] {raw_desc}"
    sql = (q.get("sql") or "").strip()
    if not sql:
      continue
    fm_lines.append(f"  - description: {_yaml_escape_scalar(desc)}")
    fm_lines.append(f"    sql: {_yaml_block_sql(sql, indent=6)}")
    fm_lines.append("    source: USER")
    fm_lines.append("    sqlDialect: GOOGLE_SQL")

  for pat, n in usage.top_query_patterns:
    desc = (
        f"[Source: INFORMATION_SCHEMA] Observed {n}× in last"
        f" {usage.window_days} days. Normalized from query history —"
        " substitute literal values before running."
    )
    fm_lines.append(f"  - description: {_yaml_escape_scalar(desc)}")
    fm_lines.append(f"    sql: {_yaml_block_sql(pat, indent=6)}")
    fm_lines.append("    source: AGENT")
    fm_lines.append("    sqlDialect: GOOGLE_SQL")

  for q in doc_queries:
    raw_desc = (q.get("description") or "").strip()
    if not raw_desc:
      raw_desc = "Example query extracted from documentation."
    desc = f"[Source: Documentation] {raw_desc}"
    sql = (q.get("sql") or "").strip()
    if not sql:
      continue
    fm_lines.append(f"  - description: {_yaml_escape_scalar(desc)}")
    fm_lines.append(f"    sql: {_yaml_block_sql(sql, indent=6)}")
    fm_lines.append("    source: AGENT")
    fm_lines.append("    sqlDialect: GOOGLE_SQL")

  if len(fm_lines) == 2:
    # All three sources produced nothing. The aspect requires the
    # `queries` array to be present + non-empty, so emit one placeholder
    # so the file stays well-formed for push.
    fm_lines.append(
        '  - description: "[Source: INFORMATION_SCHEMA] (no queries'
        ' observed in window; placeholder for future enrichment)"'
    )
    fm_lines.append(
        f'    sql: "-- No queries observed for {table_fqn} in last'
        f' {usage.window_days} days."'
    )
    fm_lines.append("    source: AGENT")
    fm_lines.append("    sqlDialect: GOOGLE_SQL")

  fm_lines.append("userManaged: false")
  fm_lines.append("job:")
  fm_lines.append(f"  name: {_yaml_escape_scalar(_JOB_NAME)}")
  fm_lines.append(f"  runTime: {_yaml_escape_scalar(run_time)}")
  fm_lines.append("---")
  return "\n".join(fm_lines) + "\n"


def _truncate(s: str, n: int) -> str:
  """Truncates a string.

  Args:
    s: Input string.
    n: Max length.

  Returns:
    Truncated string.
  """
  return s if len(s) <= n else s[: n - 1] + "…"


def _human_bytes(b: int) -> str:
  """Formats bytes.

  Args:
    b: Bytes.

  Returns:
    Human readable string.
  """
  for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
    if b < 1024 or unit == "PB":
      return f"{b:.1f} {unit}" if unit != "B" else f"{b} B"
    b /= 1024
  return f"{b:.1f} PB"
