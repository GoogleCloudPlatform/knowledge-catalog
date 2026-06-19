"""Natural-language source classifier for the enrichment agent.

Turns a single free-text `--task` description into the agent's existing typed
source flags. The heavy lifting (understanding messy English, pulling out which
URLs/identifiers are sources and what kind each is) is done by an LLM; a
deterministic guardrail layer then *filters and corrects* that output so a
hallucinated or mis-typed source never silently flows into a run.

  --task (NL)  ->  1. LLM classify  ->  2. deterministic guardrails  ->
                   3. map to flags  ->  4. echo  ->  pass through

The existing typed source flags remain the canonical interface — this is
additive sugar that *resolves into* them, and explicit flags always win over a
parse (merge handled by agent_runner).

BOOTSTRAP NOTE: the classifier is itself a Vertex call, so it needs
GOOGLE_CLOUD_PROJECT + ADC set BEFORE it runs (agent_runner does this from
--project / env / ADC default). By default it runs on the SAME `--model` the
caller already passed (no extra model dependency); `KC_LIGHT_MODEL`, if set,
optionally overrides it with a cheaper/faster model. `--project` and `--model`
are NOT extracted from the task, since you'd need them to run this parser in the
first place.

REDUCED FLAG SURFACE (matches this agent's CLI): Confluence exposes only
--confluence_space; SharePoint only --sharepoint_sites. Confluence page links and
SharePoint file links are NOT separate flags — they ride in via --folders/--docs
and the production partition_sources parsers lift them into the internal page-id
/ file-id lists. So the classifier uses a single `confluence` / `sharepoint`
category: a non-URL space KEY goes to --confluence_space, and any
Confluence/SharePoint URL is deferred to partition_sources.

GUARDRAILS (deterministic, model-free — unit-tested without Vertex):
  G1 anti-hallucination — a value not present in the task text is dropped.
  G2 URL cross-check — a recognizable URL's category is decided by regex and
     OVERRIDES the model.
  G3 shape validation — the value must fit the claimed category's shape.
  G4 confidence floor — sources below `_MIN_CONFIDENCE` are dropped.
  G5 dedup — by (category, value), case-insensitive.

NOTE: this never parses credentials. Tokens / client IDs stay in the env / setup
scripts; the parser only identifies WHAT to read, never HOW to authenticate.
"""

import os
import re
import typing as t

from pydantic import BaseModel, Field


# NOTE: the CLI surface is intentionally small. See the module docstring.
Category = t.Literal[
    "drive_folder",     # --folders   (Drive folder URL/ID)
    "drive_doc",        # --docs      (Google Doc/Sheet/Slides/file URL/ID)
    "local_path",       # --folders/--docs (local dir or .md file)
    "confluence",       # --confluence_space (key) OR a Confluence URL (deferred)
    "sharepoint",       # --sharepoint_sites (a SharePoint URL, deferred)
    "github_repo",      # --repo (+ repo_ref / repo_subdir)
    "bigquery_dataset",  # --dataset
    "bigquery_table",   # --tables
    "unknown",          # could not confidently classify -> surfaced, not used
]

_MIN_CONFIDENCE = 0.3


# Human-readable mode descriptions, lifted from the top-level README's "The
# agent has three modes" section (+ the hybrid doc+dataset variant). Shared by
# the classifier instruction (so inference matches the docs) and by the
# interactive "which mode?" prompt agent_runner shows when inference is unsure.
MODE_DESCRIPTIONS = {
    "table": (
        "Enrich an EXISTING BigQuery dataset's tables IN PLACE. Pulls the"
        " dataset's tables (schema) via kcmd, routes Drive/Confluence/SharePoint"
        " /repo context to each table by relevance, and writes an enriched"
        " overview per table (plus a `queries` aspect bundling INFORMATION_SCHEMA"
        " query patterns and doc-derived SQL) onto the live @bigquery entries."
        " Optionally maps columns to glossary terms (--glossaries)."
    ),
    "doc": (
        "Build a standalone KNOWLEDGE BASE from documents. Crawls Google Docs"
        " (and an optional Drive folder), Confluence/SharePoint pages, and/or a"
        " GitHub repo, map-reduce summarizes them, and emits a knowledge-base"
        " mdcode snapshot into an entry group. No BigQuery dataset is enriched."
    ),
    "context_overlay": (
        "Enrich a BigQuery dataset's tables WITHOUT modifying the live entries."
        " Pulls the 1P @bigquery table entries READ-ONLY (kcmd reference) and"
        " creates a NEW context-overlay entry per table in a SEPARATE editable"
        " entry group, carrying the enriched overview + queries aspect — so you"
        " ship richer descriptions without touching the live @bigquery entry."
    ),
    "hybrid": (
        "BOTH at once: a standalone document knowledge base AND a per-table"
        " context overlay for a dataset, grounded by the same sources, hosted in"
        " one entry group. Use when knowledge spans documents AND specific"
        " tables. (Realized as doc mode WITH a --dataset.)"
    ),
}


def mode_help() -> str:
  """A user-facing summary of every mode (for the 'which mode?' prompt)."""
  lines = ["Available modes:"]
  for name in ("table", "doc", "context_overlay", "hybrid"):
    lines.append(f"  • {name} — {MODE_DESCRIPTIONS[name]}")
  return "\n".join(lines)


class ClassifiedSource(BaseModel):
  """One source the model pulled out of the task description."""

  raw: str = Field(
      description=(
          "The EXACT substring from the task text this source came from — a"
          " URL, an `owner/repo`, a `project.dataset`, a path, or a space key."
          " Copy it verbatim; it is used to verify the source really appears in"
          " the task."
      )
  )
  category: Category = Field(
      description="Which source kind this is (see the allowed values)."
  )
  value: str = Field(
      description=(
          "The normalized value: a Drive/Confluence/SharePoint URL as-is; a"
          " Confluence space KEY (e.g. `DATA`); a `owner/name` repo; a"
          " `project.dataset`; a table name; or a local path."
      )
  )
  repo_ref: str = Field(
      default="",
      description="github_repo only: branch/tag/SHA if the task names one.",
  )
  repo_subdir: str = Field(
      default="",
      description="github_repo only: path prefix if the task scopes one.",
  )
  confidence: float = Field(
      description="0.0-1.0 confidence that this is a real source of this kind."
  )
  reason: str = Field(description="Short why-this-category rationale.")


class ConfigFlags(BaseModel):
  """Infra flags the task may state in passing (not sources).

  Deliberately EXCLUDES project + model: those are needed to RUN this classifier
  (a Vertex call), so they must come from --project / env / ADC and --model
  up front — they cannot be discovered from the task we are about to parse.
  """

  output_dir: str = Field(
      default="",
      description=(
          "Local OUTPUT directory path for the generated mdcode, if named"
          " (e.g. /tmp/out). This is where results are WRITTEN — NOT a source."
      ),
  )
  location: str = Field(
      default="",
      description="Vertex location, e.g. `us-central1` or `global`, if named.",
  )
  entry_group: str = Field(
      default="",
      description=(
          "Knowledge-base entry group `project.location.entryGroupId`, if"
          " named. This is a TARGET, not a source or a BigQuery table."
      ),
  )


class SourceClassification(BaseModel):
  """The classifier's full structured verdict for one task."""

  sources: list[ClassifiedSource] = Field(
      description="Every source identified in the task. Empty if none."
  )
  config: ConfigFlags = Field(
      default_factory=ConfigFlags,
      description="Infra flags stated in the task (output_dir / location / "
      "entry_group). NOT project or model.",
  )
  mode: t.Literal["", "doc", "table", "context_overlay", "hybrid"] = Field(
      default="",
      description=(
          "The enrichment MODE inferred from the task (see the instruction's"
          " MODE rules). Empty if you cannot tell — the caller falls back to"
          " 'table' if a dataset is present, else 'doc'."
      ),
  )
  topic: str = Field(
      default="",
      description=(
          "Optional: the residual free-text intent/use-case once sources are"
          " removed (maps to --topic). Empty if the task is only sources."
      ),
  )


_CLASSIFIER_INSTRUCTION = """You are a source-classification specialist for a metadata-enrichment agent. You are given ONE natural-language task describing what to enrich and WHICH SOURCES to read. Your only job is to extract every source mentioned and classify each into one category.

ALLOWED CATEGORIES (and what each is):
- drive_folder      — a Google Drive FOLDER (drive.google.com/drive/folders/...) or a bare Drive folder ID.
- drive_doc         — an individual Google item (docs.google.com/document|spreadsheets|presentation/..., drive.google.com/file/d/..., open?id=...) or a bare Doc ID.
- local_path        — a local directory or .md file: an absolute path, a ./-relative path, a BARE relative path like `agents/enrichment/corpora`, or a single dir name. value = the path exactly as written.
- confluence        — ANYTHING Confluence: a space key like `DATA` (value = the KEY), OR a Confluence page/space URL (value = the URL as-is). Do NOT try to split page vs space — just mark it `confluence`.
- sharepoint        — ANYTHING SharePoint: a site or file URL (*.sharepoint.com/...). value = the URL as-is.
- github_repo       — a GitHub repo: `owner/name` or a github.com URL. Set repo_ref if a branch/tag/SHA is named, repo_subdir if a path is scoped.
- bigquery_dataset  — a BigQuery dataset `project.dataset`. (A BARE `project.dataset.table` -> emit the dataset here AND the table as bigquery_table.)
- bigquery_table    — a specific BigQuery table to restrict to (a short table name or a `project.dataset.table`). value = the table name.
- unknown           — it sounds like a source but you cannot tell which kind. Use sparingly.

ALSO extract these INFRA flags into `config` (NOT as sources) when the task states them:
- output_dir   — the LOCAL OUTPUT directory where results are written (e.g. /tmp/out). This is a destination, NOT a source.
- location     — the Vertex location (e.g. us-central1, global).
- entry_group  — the knowledge-base entry group `project.location.entryGroupId` (a TARGET, not a source or a table).
DO NOT extract the Google Cloud project or the model — those are provided separately and are not your concern.

ALSO infer the enrichment MODE into `mode`. CRITICAL: documents / folders / Confluence / SharePoint / repos supplied to GROUND or enrich a dataset's tables are just grounding context — they do NOT by themselves mean a "knowledge base". What each mode does:
- table           — Enrich an EXISTING BigQuery dataset's tables IN PLACE: pull the tables via kcmd, route the provided context to each table by relevance, and write an enriched overview (+ a `queries` aspect of INFORMATION_SCHEMA patterns and doc-derived SQL) onto the LIVE @bigquery entries.
- doc             — Build a STANDALONE KNOWLEDGE BASE from documents (Google Docs/Drive folder, Confluence, SharePoint, GitHub repo): map-reduce summarize them into knowledge-base entries in an entry group. No BigQuery dataset is enriched.
- context_overlay — Enrich a BigQuery dataset's tables WITHOUT modifying the live entries: pull the 1P @bigquery entries READ-ONLY and create a NEW overlay entry per table in a SEPARATE editable entry group (overview + queries aspect), leaving the live @bigquery entry untouched.
- hybrid          — BOTH a standalone document knowledge base AND a per-table context overlay for a dataset, grounded by the same sources, in one entry group.

Decide in this PRECEDENCE order (first match wins):
1. hybrid          — the task explicitly asks for BOTH a knowledge base AND per-table overlays ("knowledge base PLUS per-table overlays", "KB + overlays"). Both ideas must be stated.
2. context_overlay — a dataset enriched into a SEPARATE/own entry group as OVERLAY entries, live @bigquery entries untouched. Signals: "overlay", "separate/own entry group", "don't touch/modify the live entries". Grounding docs may be present; still wins over table/doc.
3. doc             — a standalone knowledge base from documents, NO BigQuery dataset being enriched. Signals: "build a knowledge base", "from these docs/wiki".
4. table           — an EXISTING dataset's tables enriched IN PLACE. The DEFAULT whenever a dataset is named without overlay/KB language — grounding docs do NOT change this.
5. "" (empty)      — set this when the task is genuinely AMBIGUOUS about which mode is wanted (e.g. a dataset is named but it is unclear whether to modify the live entries vs. create overlays, or whether a standalone KB is also wanted). The caller will then ASK the user. Prefer a confident mode when the task is clear; use "" ONLY when you truly cannot decide.

RULES:
1. EXTRACT ONLY WHAT IS PRESENT. Never invent a URL, repo, dataset, space, path, or directory that is not literally in the task. For each source, copy the exact substring into `raw`.
2. Classify by the strongest signal: the host of a URL, the shape of an identifier, or an explicit phrase ("the Confluence space DATA", "the runbooks folder in Drive").
3. NEVER extract credentials, tokens, passwords, client IDs, or emails. They are not sources — ignore them entirely.
4. CONFIG IS NOT A SOURCE. The output directory, location, and entry group go ONLY in `config`. Do NOT also emit them as `sources` (e.g. an output path is not a local_path source; an entry group is not a bigquery_table).
5. Put the residual non-source intent (what the enrichment is FOR) into `topic`. If the whole task is just sources, leave `topic` empty.
6. Be honest with `confidence`. If you are guessing, score low.
7. Output STRICT JSON conforming to the schema. No prose, no Markdown, no fenced blocks."""


def create_source_classifier_runner(model: str | None = None):
  """Build the focused, schema-constrained classification agent.

  Model selection (no extra dependency on the caller): `KC_LIGHT_MODEL` if set
  (optional cost/speed override) else the caller's `model` (the `--model` the
  user already passed and validated) else, as a last resort, engine._LIGHT_MODEL.
  Lazy imports keep the deterministic guardrail layer (and its unit tests)
  importable without google.adk installed.
  """
  from engine import VertexGemini, _LIGHT_MODEL  # noqa: PLC0415
  from google.adk.agents import llm_agent  # noqa: PLC0415
  from google.adk.runners import InMemoryRunner  # noqa: PLC0415

  chosen = os.environ.get("KC_LIGHT_MODEL") or model or _LIGHT_MODEL
  agent = llm_agent.LlmAgent(
      name="SourceClassifierAgent",
      description=(
          "Classifies the sources named in a natural-language task into the"
          " agent's typed source categories."
      ),
      model=VertexGemini(model=chosen),
      instruction=_CLASSIFIER_INSTRUCTION,
      output_schema=SourceClassification,
  )
  return InMemoryRunner(agent=agent)


# ============================ Deterministic guardrails ============================

_DRIVE_HOST_RE = re.compile(r"(drive|docs)\.google\.com", re.I)
_DRIVE_FOLDER_PATH_RE = re.compile(r"/folders/", re.I)
_CONFLUENCE_HOST_RE = re.compile(r"(atlassian\.net|/wiki/)", re.I)
_SHAREPOINT_HOST_RE = re.compile(r"\.sharepoint\.com", re.I)
_GITHUB_URL_RE = re.compile(r"github\.com/([\w.-]+/[\w.-]+)", re.I)
_GITHUB_SLUG_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
_BQ_DATASET_RE = re.compile(r"^[a-z][\w-]*\.[A-Za-z_]\w*$")
_BQ_TABLE_FQN_RE = re.compile(r"^[a-z][\w-]*\.[A-Za-z_]\w*\.[A-Za-z_]\w*$")
_LOCAL_PATH_RE = re.compile(r"^(?:~|\.{0,2}/)|\.(?:md|markdown)$", re.I)
_URL_RE = re.compile(r"https?://", re.I)


def _norm(s: str) -> str:
  """Lowercase + collapse whitespace, for substring / dedup comparisons."""
  return re.sub(r"\s+", " ", (s or "").strip().lower())


def deterministic_url_category(token: str) -> str | None:
  """Return the category a token's *shape* implies, or None if unrecognized.

  Only fires on shapes we can decide with certainty. Used as the authority in
  guardrail G2.
  """
  s = (token or "").strip()
  if not s:
    return None
  # Any Google Drive/Docs URL: folder iff the path has /folders/, else an
  # individual item (doc/sheet/slides/file) -> a doc source.
  if _DRIVE_HOST_RE.search(s):
    return "drive_folder" if _DRIVE_FOLDER_PATH_RE.search(s) else "drive_doc"
  if _SHAREPOINT_HOST_RE.search(s):
    return "sharepoint"
  if _CONFLUENCE_HOST_RE.search(s):
    # Any Confluence URL (space or page) -> `confluence`; partition_sources
    # decides space-vs-page downstream.
    return "confluence"
  if _GITHUB_URL_RE.search(s):
    return "github_repo"
  # Non-URL identifier shapes (only when it is NOT some other URL).
  if not _URL_RE.search(s):
    if _BQ_TABLE_FQN_RE.match(s):
      return "bigquery_table"
    if _BQ_DATASET_RE.match(s):
      return "bigquery_dataset"
    if _LOCAL_PATH_RE.search(s):
      return "local_path"
    # A multi-segment relative path (a/b/c) is unambiguously a local path, not
    # a `owner/repo` GitHub slug (which is exactly two segments).
    if s.count("/") >= 2:
      return "local_path"
    # A BARE two-segment `owner/repo` slug is left ambiguous on purpose: real
    # GitHub references carry a github.com URL (caught above by host), so a bare
    # `a/b` is just as likely a local path. Defer to the model/context here.
  return None


def _value_matches_category(category: str, value: str) -> bool:
  """Guardrail G3: does `value` plausibly fit the claimed category's shape?"""
  v = (value or "").strip()
  if not v:
    return False
  # For both Drive categories, G2 has already split folder vs file by the URL
  # path; here we just accept any Google URL or a bare id.
  if category == "drive_folder":
    return bool(_DRIVE_HOST_RE.search(v)) or "/" not in v
  if category == "drive_doc":
    return bool(_DRIVE_HOST_RE.search(v)) or "/" not in v
  if category == "local_path":
    # Treat any non-URL, non-phrase token as a (relative) local path: absolute,
    # ~, ./-relative, .md file, multi-segment relative dir (a/b/c), or a single
    # dir name. Reject URLs and free-text phrases (which contain spaces).
    if _URL_RE.search(v):
      return False
    return (
        bool(_LOCAL_PATH_RE.search(v))
        or "/" in v
        or bool(re.match(r"^[\w.-]+$", v))
    )
  if category == "confluence":
    # A space KEY (short, no spaces) or any Confluence URL.
    return bool(_CONFLUENCE_HOST_RE.search(v)) or bool(
        re.match(r"^[A-Za-z0-9_~][\w-]*$", v)
    )
  if category == "sharepoint":
    return bool(_SHAREPOINT_HOST_RE.search(v))
  if category == "github_repo":
    return bool(_GITHUB_URL_RE.search(v)) or bool(_GITHUB_SLUG_RE.match(v))
  if category == "bigquery_dataset":
    return bool(_BQ_DATASET_RE.match(v)) or bool(_BQ_TABLE_FQN_RE.match(v))
  if category == "bigquery_table":
    return True  # short names are valid; hard to over-constrain
  return False


def _github_slug(value: str) -> str:
  """Normalize a github value (URL or slug) to `owner/name`."""
  m = _GITHUB_URL_RE.search(value or "")
  if m:
    return m.group(1).removesuffix(".git")
  return (value or "").strip().removesuffix(".git")


def apply_guardrails(
    result: SourceClassification, task: str
) -> tuple[list[ClassifiedSource], list[tuple[ClassifiedSource, str]]]:
  """Filter + correct the model's classification deterministically.

  Returns (kept, dropped) where dropped is a list of (source, reason).
  """
  task_n = _norm(task)
  kept: list[ClassifiedSource] = []
  dropped: list[tuple[ClassifiedSource, str]] = []
  seen: set[tuple[str, str]] = set()

  for src in result.sources:
    # G1: anti-hallucination — raw (or value) must appear in the task.
    raw_n, val_n = _norm(src.raw), _norm(src.value)
    if not ((raw_n and raw_n in task_n) or (val_n and val_n in task_n)):
      dropped.append((src, "not found in task text (possible hallucination)"))
      continue

    # G2: URL/shape cross-check — deterministic verdict wins when it has one.
    probe = src.raw if (raw_n and raw_n in task_n) else src.value
    det = deterministic_url_category(probe) or deterministic_url_category(
        src.value
    )
    category = src.category
    if det and det != category:
      category = det

    if category == "unknown":
      dropped.append((src, "model could not classify (unknown)"))
      continue

    value = src.value.strip()
    if category == "github_repo":
      value = _github_slug(value)

    # G3: shape validation.
    if not _value_matches_category(category, value):
      dropped.append(
          (src, f"value {value!r} does not fit category {category}")
      )
      continue

    # G4: confidence floor.
    if src.confidence < _MIN_CONFIDENCE:
      dropped.append(
          (src, f"confidence {src.confidence:.2f} < {_MIN_CONFIDENCE}")
      )
      continue

    # G5: dedup.
    key = (category, value.lower())
    if key in seen:
      continue
    seen.add(key)

    kept.append(
        ClassifiedSource(
            raw=src.raw,
            category=category,
            value=value,
            repo_ref=src.repo_ref,
            repo_subdir=src.repo_subdir,
            confidence=src.confidence,
            reason=src.reason,
        )
    )

  return kept, dropped


# ============================ Mapping to flags ============================

_LIST_FLAG_FOR = {
    "drive_folder": "folders",
    "drive_doc": "docs",
    "bigquery_table": "tables",
}


def to_flag_values(kept: list[ClassifiedSource]) -> dict:
  """Map kept sources to a dict of {flag_name: value} the caller merges in.

  List flags accumulate; `repo` / `dataset` (+ repo_ref / repo_subdir) are
  scalars and take the FIRST classified value (the caller's explicit flag, if
  any, still wins over this).
  """
  out: dict = {
      "docs": [],
      "folders": [],
      "confluence_space": [],
      "tables": [],
      "repo": "",
      "repo_ref": "",
      "repo_subdir": "",
      "dataset": "",
      # Confluence/SharePoint URLs are NOT pre-resolved here — they go into this
      # mixed list, which the caller feeds to the production
      # confluence_tools/sharepoint_tools.partition_sources parsers. Those
      # extract the page id / space key / site (and warn on links they cannot
      # resolve). Only a NON-URL Confluence space KEY is routed straight to
      # --confluence_space.
      "mixed_passthrough": [],
  }
  for src in kept:
    if src.category == "local_path":
      # A local .md FILE is a doc spine (--docs); a local DIR is a corpus
      # (--folders, read recursively).
      flag = "docs" if src.value.lower().endswith((".md", ".markdown")) else (
          "folders"
      )
      out[flag].append(src.value)
    elif src.category == "confluence":
      if _URL_RE.search(src.value):
        out["mixed_passthrough"].append(src.value)
      else:
        out["confluence_space"].append(src.value)
    elif src.category == "sharepoint":
      out["mixed_passthrough"].append(src.value)
    elif src.category in _LIST_FLAG_FOR:
      out[_LIST_FLAG_FOR[src.category]].append(src.value)
    elif src.category == "github_repo":
      if not out["repo"]:
        out["repo"] = src.value
        out["repo_ref"] = src.repo_ref
        out["repo_subdir"] = src.repo_subdir
    elif src.category == "bigquery_dataset":
      if not out["dataset"]:
        out["dataset"] = src.value
  return out


# Human-readable flag label for the echo. (confluence_page_ids / sharepoint_sites
# are populated by partition_sources downstream and shown by the caller.)
_FLAG_LABEL = {
    "docs": "--docs",
    "folders": "--folders",
    "confluence_space": "--confluence_space",
    "confluence_page_ids": "--confluence_page_ids (lifted)",
    "sharepoint_sites": "--sharepoint_sites",
    "tables": "--tables",
    "repo": "--repo",
    "dataset": "--dataset",
}

# Config fields to echo, and which are compulsory. (project/model are resolved
# up front and echoed by agent_runner directly.)
_CONFIG_LABELS = (
    ("project", "--project", True),
    ("model", "--model", True),
    ("output_dir", "--output_dir", True),
    ("location", "--location", False),
    ("entry_group", "--entry_group", False),
)


def format_echo(
    flag_values: dict,
    dropped: list[tuple[ClassifiedSource, str]],
    inferred_mode: str = "",
    config: dict | None = None,
) -> str:
  """Render the resolved config + identified sources block."""
  lines = []
  if config is not None:
    lines += ["", "Resolved configuration:"]
    for key, label, required in _CONFIG_LABELS:
      val = config.get(key)
      if val:
        lines.append(f"  {label:<22} : {val}")
      elif required:
        lines.append(f"  {label:<22} : (MISSING — required)")
  lines += ["", "Identified sources from your --task:"]
  any_source = False
  for flag, label in _FLAG_LABEL.items():
    val = flag_values.get(flag)
    if not val:
      continue
    any_source = True
    if isinstance(val, list):
      for item in val:
        lines.append(f"  {label:<30} : {item}")
    else:
      extra = ""
      if flag == "repo":
        if flag_values.get("repo_ref"):
          extra += f"  (ref={flag_values['repo_ref']})"
        if flag_values.get("repo_subdir"):
          extra += f"  (subdir={flag_values['repo_subdir']})"
      lines.append(f"  {label:<30} : {val}{extra}")
  if not any_source:
    lines.append("  (none — no sources were confidently identified)")
  if inferred_mode:
    lines.append(f"  {'--mode (resolved)':<30} : {inferred_mode}")
  if dropped:
    lines.append("")
    lines.append("Ignored (not used):")
    for src, reason in dropped:
      lines.append(f"  - {src.raw!r} [{src.category}] — {reason}")
  lines.append("")
  return "\n".join(lines)


def apply_config_guardrails(config: ConfigFlags, task: str) -> dict:
  """Filter the model's config extraction deterministically (anti-hallucination)."""
  task_n = _norm(task)
  out: dict = {}
  for field in ("output_dir", "location", "entry_group"):
    val = (getattr(config, field, "") or "").strip()
    if not val:
      continue
    if _norm(val) not in task_n:  # G1 anti-hallucination
      continue
    out[field] = val
  # Shape sanity: an entry group is `project.location.entryGroupId`.
  if "entry_group" in out and out["entry_group"].count(".") < 2:
    out.pop("entry_group")
  return out


async def classify_task(task: str, model: str | None = None,
                        usage_acc: dict | None = None):
  """End-to-end: LLM classify -> guardrails.

  Returns (kept_sources, dropped, topic, config_dict). Runs on the light model
  unless `model` is given. Lazy-imports the ADK plumbing.
  """
  from common import run_schema_agent  # noqa: PLC0415

  runner = create_source_classifier_runner(model)
  prompt = f"TASK:\n{task}\n\nClassify every source and config flag per the schema."
  result = await run_schema_agent(
      runner, prompt, SourceClassification, usage_acc or {"input": 0, "output": 0}
  )
  kept, dropped = apply_guardrails(result, task)
  config = apply_config_guardrails(result.config, task)
  # The inferred mode is a fixed enum (no hallucination risk), so it bypasses
  # the substring anti-hallucination check and rides along in the config dict.
  if result.mode:
    config["mode"] = result.mode
  # Defensive: if the model ALSO emitted the output dir as a local_path source,
  # drop it from the sources (config is not a source).
  out_dir_n = _norm(config.get("output_dir", ""))
  if out_dir_n:
    kept = [
        s for s in kept
        if not (s.category == "local_path" and _norm(s.value) == out_dir_n)
    ]
  return kept, dropped, (result.topic or ""), config
