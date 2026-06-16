"""Unified enrichment agent entrypoint.

Dispatches to one of three flows based on `--mode`:
  * doc    — recursive Google-Docs crawl -> map-reduce summarize -> LLM-emitted
             knowledge-base mdcode entries (manifest scaffolded by
             `kcmd init --entry-group`; a normal entry group, STANDARD layout).
  * table  — kcmd-pulled BigQuery dataset discovery -> relevance-routed,
             folder-grounded table overviews (kcmd bq-dataset format).
  * context_overlay — like table, but the 1P table entries are pulled READ-ONLY
             via `kcmd reference`; one NEW context-overlay entry is created per
             table in the editable `--entry-group` (overlay output format).

When `--mode` is empty it is inferred: a `--dataset` implies table, else doc.
(context_overlay is never inferred — pass `--mode=context_overlay` explicitly.)

The agent runs the READ-ONLY kcmd commands itself (`init`, `pull`); generating
`catalog.yaml` + the local entries. The customer runs `kcmd push` to publish.

Nothing is project-specific: pass your own `--project`, `--location`, and
`--model`; for doc mode also pass `--entry-group`.
"""

import asyncio
import os

from absl import app
from absl import flags
from modes import context_overlay_mode, doc_mode, table_mode
import refine

_MODE = flags.DEFINE_enum(
    "mode",
    "",
    ["", "doc", "table", "context_overlay"],
    "Which enrichment flow to run. Empty = infer from flags.",
)
_TOPIC = flags.DEFINE_string(
    "topic",
    "Metadata enrichment",
    "Free-text use case / instruction guiding enrichment (anything).",
)
_DOCS = flags.DEFINE_list(
    "docs", [],
    "Comma-separated mixed list, routed per entry: Google Doc URLs/IDs and/or "
    "local .md files. A local .md file is a doc-mode depth-0 spine; for "
    "table/context_overlay it grounds table overviews."
)
_FOLDERS = flags.DEFINE_list(
    "folders", [],
    "Comma-separated mixed list, routed per entry: Google Drive folder "
    "URLs/IDs and/or local directories of .md files. Drive/local dirs seed "
    "depth-1 children (doc mode) or grounding docs (table/context_overlay)."
)
# Backward-compatible alias for the former singular flag; merged with --folders.
_FOLDER = flags.DEFINE_list(
    "folder", [], "Deprecated alias for --folders (merged with it)."
)

# --- Source code input (all modes): agentic GitHub repo understanding -------
# When --repo is set, a code-understanding agent explores the repository via the
# GitHub MCP server and contributes code component cards as an additional
# context source. In doc mode the components can surface as their own KB
# entries; in table/context_overlay mode they join the relevance-router's
# candidate pool so code that touches a table grounds that table's overview.
# See tools/github_tools.py. The MCP server is configured via --mcp_config (or
# KC_ENRICH_MCP_CONFIG); a GitHub PAT is supplied to the server via its env
# (default env var GITHUB_PERSONAL_ACCESS_TOKEN).
_REPO = flags.DEFINE_string(
    "repo",
    "",
    "Optional GitHub repo as `owner/name` or a github URL — an extra code"
    " context source for ANY mode (explored agentically via the GitHub MCP"
    " server).",
)
_REPO_REF = flags.DEFINE_string(
    "repo_ref",
    "",
    "Optional branch/tag/SHA for --repo (empty = the repo's default branch).",
)
_REPO_SUBDIR = flags.DEFINE_string(
    "repo_subdir",
    "",
    "Optional path prefix to scope the --repo exploration (e.g. `src/server`).",
)
_MCP_CONFIG = flags.DEFINE_string(
    "mcp_config",
    "",
    "Path to an mcp.json describing the GitHub MCP server (falls back to"
    " KC_ENRICH_MCP_CONFIG, then a built-in `github-mcp-server stdio`"
    " default).",
)
_DATASET = flags.DEFINE_string(
    "dataset",
    "",
    "BigQuery dataset as `project.dataset` (table/context_overlay mode).",
)
_TABLES = flags.DEFINE_list(
    "tables",
    [],
    "Optional table filter for context_overlay mode (short names or"
    " `proj.ds.table` FQNs). Empty = enrich every table in --dataset.",
)
_OUTPUT_DIR = flags.DEFINE_string(
    "output_dir", None, "Local directory path for the generated mdcode."
)

# Customer-supplied GCP + model configuration (nothing is hardcoded).
_PROJECT = flags.DEFINE_string(
    "project", None, "Google Cloud project for the Vertex AI model (required)."
)
_LOCATION = flags.DEFINE_string(
    "location", "global", "Vertex AI location for the model."
)
_MODEL = flags.DEFINE_string(
    "model", None, "Model for the agent, e.g. `gemini-2.5-pro` (required)."
)
_ENTRY_GROUP = flags.DEFINE_string(
    "entry_group",
    None,
    "Knowledge Base entry group `project.location.entryGroupId` (doc mode).",
)
_GLOSSARIES = flags.DEFINE_list(
    "glossaries",
    [],
    "Optional. Comma-separated list of existing Dataplex Glossaries "
    "`project.location.glossaryId`. When supplied in table mode, the agent "
    "additionally maps BQ columns to glossary terms and injects field-level "
    "`links.definition`.",
)
_INTERACTIVE = flags.DEFINE_bool(
    "interactive",
    False,
    "After the initial enrichment, stay in an interactive REPL to accept"
    " free-text refinement requests (reuses loaded context — no doc re-read).",
)
_REFINE_INSTRUCTION = flags.DEFINE_string(
    "refine_instruction",
    "",
    "Apply ONE refinement turn to the saved session in --output_dir, then exit"
    " (no pipeline re-run). Used by the webapp's persist+re-invoke refine flow;"
    " requires --output_dir, --project, --model.",
)

# --- table mode: BQ query-history usage signals ---------------------------
# Pull from `region-<R>.INFORMATION_SCHEMA.JOBS_BY_PROJECT` (with
# JOBS_BY_USER fallback) and emit a `<table>.queries.md` aspect sidecar
# alongside `<table>.overview.md`. The queries sidecar conforms to the
# Dataplex `queries` aspect type (`dataplex-types.global.queries`) and is
# pushed via `kcmd push` because `dataplex-types.global.queries` is now in
# `publishing.aspects` of `_BQ_MANIFEST` in kcmd_tools.py.
_INCLUDE_USAGE = flags.DEFINE_bool(
    "include_usage",
    True,
    "Table mode: fetch BQ query-history usage signal per table from"
    " INFORMATION_SCHEMA.JOBS_BY_*. Off skips the BQ step entirely.",
)
_USAGE_WINDOW_DAYS = flags.DEFINE_integer(
    "usage_window_days",
    30,
    "Days of query history to aggregate (default 30).",
)
_ANONYMIZE_USERS = flags.DEFINE_bool(
    "anonymize_users",
    False,
    "Replace user emails with stable SHA hashes in the usage signal.",
)
_USAGE_SCOPE = flags.DEFINE_enum(
    "usage_scope",
    "auto",
    ["auto", "project", "user"],
    "auto = try JOBS_BY_PROJECT then fall back to JOBS_BY_USER on permission"
    " failure; project = require JOBS_BY_PROJECT; user = only the caller's"
    " own queries (always works but narrow).",
)

# --- User-feedback proposals (applies to all 3 modes) -------------------
# Feedback files are pure JSON (typically with `.md` extension by upstream
# convention) shaped `{"proposals": [...]}`. Each proposal targets a
# table/column FQN and carries a `proposed_enrichment` action + an optional
# `eval_candidate.golden_sql`. The agent treats these as HIGHEST priority —
# they OVERRIDE conflicting context from Drive docs, search hits, and
# INFORMATION_SCHEMA-derived patterns. See tools/feedback_tools.py for
# the full schema + routing semantics.
_FEEDBACK_DIR = flags.DEFINE_string(
    "feedback_dir",
    None,
    "Optional directory containing user-feedback `.md`/`.json` files."
    " Walked recursively; each file holds a `{proposals: [...]}` JSON"
    " payload from the upstream feedback collector.",
)
_FEEDBACK_FILES = flags.DEFINE_list(
    "feedback_files",
    [],
    "Optional explicit list of user-feedback file paths (alternative to /"
    " in addition to --feedback_dir).",
)


def _load_dotenv():
  """Best-effort load of a local `.env` (python-dotenv, if installed).

  Lets non-Vertex runs keep KC_MODEL_PROVIDER / OPENAI_API_BASE / OPENAI_API_KEY
  (and the GCP vars) in a `.env` beside the agent instead of exporting them.
  No-op if python-dotenv isn't installed or no `.env` is present. Existing
  environment variables win (`override=False`), so explicit exports still take
  precedence.
  """
  try:
    from dotenv import load_dotenv  # pylint: disable=g-import-not-at-top
  except ImportError:
    return
  here = os.path.dirname(os.path.abspath(__file__))
  for path in (os.path.join(here, ".env"), os.path.join(os.getcwd(), ".env")):
    if os.path.exists(path):
      load_dotenv(path, override=False)


def main(argv):
  _load_dotenv()
  if len(argv) > 1:
    raise app.UsageError("Too many command-line arguments.")
  if not _PROJECT.value:
    raise app.UsageError("--project is required (your Google Cloud project).")
  if not _MODEL.value:
    raise app.UsageError("--model is required (e.g. --model=gemini-2.5-pro).")

  # Configure Vertex AI for the agent's model from the customer's flags.
  os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"
  os.environ["GOOGLE_CLOUD_PROJECT"] = _PROJECT.value
  os.environ["GOOGLE_CLOUD_LOCATION"] = _LOCATION.value

  # Refinement re-invocation: rehydrate the saved session and apply one turn,
  # skipping the enrichment pipeline entirely (no doc re-read / dataset re-pull).
  if _REFINE_INSTRUCTION.value:
    if not _OUTPUT_DIR.value:
      raise app.UsageError("--output_dir is required with --refine_instruction.")
    asyncio.run(
        refine.run_one_refinement(
            _OUTPUT_DIR.value, _REFINE_INSTRUCTION.value, _MODEL.value
        )
    )
    return

  mode = _MODE.value or ("table" if _DATASET.value else "doc")

  # --folders is canonical; --folder is a deprecated alias. Merge both so old
  # invocations keep working.
  folder_inputs = list(_FOLDERS.value or []) + list(_FOLDER.value or [])

  if mode == "context_overlay":
    if not _DATASET.value:
      raise app.UsageError(
          "--dataset is required for context_overlay mode (`project.dataset`)."
      )
    if not _ENTRY_GROUP.value:
      raise app.UsageError(
          "--entry_group is required for context_overlay mode "
          "(`project.location.entryGroupId` where overlays are created)."
      )
    session = asyncio.run(
        context_overlay_mode.run(
            _DATASET.value,
            folder_inputs,
            _TOPIC.value,
            _OUTPUT_DIR.value,
            _MODEL.value,
            _ENTRY_GROUP.value,
            docs=_DOCS.value,
            tables_filter=_TABLES.value,
            include_usage=_INCLUDE_USAGE.value,
            usage_window_days=_USAGE_WINDOW_DAYS.value,
            anonymize_users=_ANONYMIZE_USERS.value,
            usage_scope=_USAGE_SCOPE.value,
            feedback_dir=_FEEDBACK_DIR.value,
            feedback_files=_FEEDBACK_FILES.value,
            repo=_REPO.value,
            repo_ref=_REPO_REF.value,
            repo_subdir=_REPO_SUBDIR.value,
            mcp_config=_MCP_CONFIG.value,
        )
    )
  elif mode == "table":
    session = asyncio.run(
        table_mode.run(
            _DATASET.value,
            folder_inputs,
            _TOPIC.value,
            _OUTPUT_DIR.value,
            _MODEL.value,
            include_usage=_INCLUDE_USAGE.value,
            usage_window_days=_USAGE_WINDOW_DAYS.value,
            anonymize_users=_ANONYMIZE_USERS.value,
            usage_scope=_USAGE_SCOPE.value,
            feedback_dir=_FEEDBACK_DIR.value,
            feedback_files=_FEEDBACK_FILES.value,
            glossaries=_GLOSSARIES.value or None,
            repo=_REPO.value,
            repo_ref=_REPO_REF.value,
            repo_subdir=_REPO_SUBDIR.value,
            mcp_config=_MCP_CONFIG.value,
        )
    )
  else:
    if not _ENTRY_GROUP.value:
      raise app.UsageError(
          "--entry_group is required for doc mode "
          "(`project.location.entryGroupId`)."
      )
    session = asyncio.run(
        doc_mode.run(
            _TOPIC.value,
            _DOCS.value,
            folder_inputs,
            _OUTPUT_DIR.value,
            _MODEL.value,
            _ENTRY_GROUP.value,
            feedback_dir=_FEEDBACK_DIR.value,
            feedback_files=_FEEDBACK_FILES.value,
            repo=_REPO.value,
            repo_ref=_REPO_REF.value,
            repo_subdir=_REPO_SUBDIR.value,
            mcp_config=_MCP_CONFIG.value,
        )
    )

  # Persist the session so a later `--refine_instruction` re-invocation (the
  # webapp refine flow) can rehydrate it without re-running the pipeline. Cheap
  # and harmless for one-shot/CLI runs.
  if session:
    refine.save_session(session)

  # Multi-turn refinement: stay in a REPL reusing the loaded context. Opt-in via
  # --interactive so the default one-shot behavior (and the webapp subprocess
  # path) is unchanged. run_repl is a no-op on a non-tty or empty session.
  if _INTERACTIVE.value and session:
    asyncio.run(refine.run_repl(session, _MODEL.value))


if __name__ == "__main__":
  app.run(main)
