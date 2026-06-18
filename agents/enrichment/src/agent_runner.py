"""Unified enrichment agent entrypoint.

Dispatches to one of three flows based on `--mode`:
  * doc    — recursive Google-Docs crawl -> map-reduce summarize -> LLM-emitted
             knowledge-base mdcode entries (manifest scaffolded by
             `kcmd init --entry-group`; a normal entry group, STANDARD layout).
             HYBRID: if `--dataset` is ALSO passed in doc mode, doc mode adds a
             context-overlay entry per table in that dataset (grounded by the
             same docs), alongside the standalone KB entries — for knowledge that
             doesn't belong on a single table. One entry group hosts both (the EG
             is scaffolded with the overlay manifest + the dataset referenced).
  * table  — kcmd-pulled BigQuery dataset discovery -> relevance-routed,
             folder-grounded table overviews (kcmd bq-dataset format).
  * context_overlay — like table, but the 1P table entries are pulled READ-ONLY
             via `kcmd reference`; one NEW context-overlay entry is created per
             table in the editable `--entry-group` (overlay output format).

When `--mode` is empty it is inferred: a `--dataset` implies table, else doc.
(context_overlay is never inferred — pass `--mode=context_overlay` explicitly.)
(HYBRID is never inferred either — pass `--mode=doc` WITH `--dataset` explicitly;
a bare `--dataset` still infers plain table mode.)

The agent runs the READ-ONLY kcmd commands itself (`init`, `pull`); generating
`catalog.yaml` + the local entries. The customer runs `kcmd push` to publish.

Nothing is project-specific: pass your own `--project`, `--location`, and
`--model`; for doc mode also pass `--entry-group`.
"""

import asyncio
import os
import sys

from absl import app
from absl import flags
from modes import context_overlay_mode, doc_mode, table_mode
import refine
from tools import confluence_tools, sharepoint_tools


def _source_microsoft_env() -> None:
  """Load `~/.config/kc_agent/microsoft.env` (MICROSOFT_CLIENT_ID /
  MICROSOFT_TENANT_ID, written by setup_sharepoint.py) into os.environ.

  Existing env vars win — the file is a default, not an override. Also
  re-sourced after the setup subprocess so its newly-written IDs reach
  this process (subprocess env mutations don't propagate to the parent).
  """
  env_file = os.path.expanduser("~/.config/kc_agent/microsoft.env")
  if not os.path.exists(env_file):
    return
  try:
    with open(env_file, "r", encoding="utf-8") as f:
      for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
          continue
        if not line.startswith("export "):
          continue
        body = line[len("export "):]
        if "=" not in body:
          continue
        key, val = body.split("=", 1)
        val = val.strip().strip("'").strip('"')
        if key and not os.environ.get(key):
          os.environ[key] = val
  except OSError:
    pass

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
    "Comma-separated mixed list, routed per entry: Google Doc URLs/IDs, "
    "local .md files, Confluence page URLs (auto-lifted into the Confluence "
    "source), and/or SharePoint URLs (site URLs auto-merged into "
    "--sharepoint_sites). A local .md file is a doc-mode depth-0 spine; for "
    "table/context_overlay it grounds table overviews."
)
_FOLDERS = flags.DEFINE_list(
    "folders", [],
    "Comma-separated mixed list, routed per entry: Google Drive folder "
    "URLs/IDs, local directories of .md files, Confluence URLs (space or "
    "page links — auto-lifted into the Confluence source), and/or "
    "SharePoint URLs (site URLs auto-merged into --sharepoint_sites). "
    "Drive/local dirs seed depth-1 children (doc mode) or grounding docs "
    "(table/context_overlay)."
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
    " default). The same file may also carry an Atlassian Rovo MCP server"
    " entry under key `atlassian_remote` for --confluence_* sources.",
)

# --- Confluence input (all modes) ----------------------------------------
# A Confluence agent explores Atlassian via the Rovo MCP server and returns
# page cards in the same router-descriptor shape as the GitHub source (see
# tools/confluence_tools.py; auth via ATLASSIAN_API_TOKEN / ATLASSIAN_OAUTH_TOKEN,
# --mcp_config can override the server). Only --confluence_space is on the CLI;
# the CQL and page-id sources stay internal (page links in --folders / --docs
# are auto-lifted into them).
_CONFLUENCE_SPACES = flags.DEFINE_list(
    "confluence_space",
    [],
    "Optional Confluence space keys to ingest as a corpus context source"
    " (e.g. `DATA,RUNBOOKS`). Top-level pages are listed and the most"
    " topic-relevant ones are read. Confluence page/space URLs may also be"
    " dropped into --folders / --docs — they are auto-detected and lifted"
    " into this source.",
)

# --- SharePoint input (all modes) ----------------------------------------
# An inner agent drives Microsoft Graph REST (site → library → folder → file)
# via sp_* FunctionTools — direct Graph, not MCP, since the first-party
# SharePoint MCP rejects third-party Entra tokens. Returns file cards in the
# same shape as the other sources (see tools/sharepoint_tools.py; text files
# read in full, .docx/.xlsx/.pptx/PDF extracted locally). Auth: MSAL cache or
# MICROSOFT_ACCESS_TOKEN (see scripts/setup_sharepoint.py). Only
# --sharepoint_sites is on the CLI; the search and file-id sources stay
# internal (file links in --folders / --docs are auto-lifted into them).
_SHAREPOINT_SITES = flags.DEFINE_list(
    "sharepoint_sites",
    [],
    "Optional SharePoint sites — accepts full site URLs from your"
    " browser's address bar, e.g."
    " `https://contoso.sharepoint.com/sites/Marketing`. Walks each site's"
    " default library and reads files that look topic-relevant. You can"
    " also drop these URLs into --folders / --docs interchangeably. The"
    " legacy `<host>:<server-relative-path>` form (e.g."
    " `contoso.sharepoint.com:sites/Marketing`) is still accepted for"
    " back-compat.",
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
_OUTPUT_FORMAT = flags.DEFINE_enum(
    "output_format",
    "kcmd",
    ["kcmd", "okf"],
    "Output serialization format. 'kcmd' (default) writes the native catalog"
    " layout (X.yaml + X.overview.md under catalog/). 'okf' writes an Open"
    " Knowledge Format bundle (one X.md per concept with YAML frontmatter +"
    " index.md listings under bundle/), publishable via `kcmd push --format"
    " okf`.",
)


def main(argv):
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
  doc_inputs = list(_DOCS.value or [])

  # Lift Confluence URLs out of --folders / --docs into the typed Confluence
  # source lists. Drive URLs/IDs and local markdown paths/dirs pass through
  # untouched, so the existing per-mode routing in is_local_path() stays
  # correct (it would otherwise route a Confluence URL as a Drive link and
  # produce a silent dud). Space links merge into --confluence_space; page
  # links seed the internal page-id list (no longer its own CLI flag).
  folder_inputs, confluence_spaces, confluence_page_ids = (
      confluence_tools.partition_sources(
          folder_inputs,
          _CONFLUENCE_SPACES.value,
          [],
      )
  )
  doc_inputs, confluence_spaces, confluence_page_ids = (
      confluence_tools.partition_sources(
          doc_inputs, confluence_spaces, confluence_page_ids
      )
  )

  # Same lift for SharePoint URLs — site URLs land in --sharepoint_sites and
  # file links seed the internal file-id list (no longer its own CLI flag).
  # Viewer/sharing links surface a warning (sourcedoc GUIDs can't be resolved
  # to a Graph driveItem id without a roundtrip we'd rather not bake into a
  # parse step).
  folder_inputs, sharepoint_sites, sharepoint_file_ids = (
      sharepoint_tools.partition_sources(
          folder_inputs,
          _SHAREPOINT_SITES.value,
          [],
      )
  )
  doc_inputs, sharepoint_sites, sharepoint_file_ids = (
      sharepoint_tools.partition_sources(
          doc_inputs, sharepoint_sites, sharepoint_file_ids
      )
  )

  # Credentials gate — SharePoint only. Triggers ONLY when the user actually
  # asked for SharePoint reads AND no creds are configured. Stays silent
  # otherwise so users who never touch SharePoint aren't prompted. On a tty we
  # offer to launch setup_sharepoint.py inline; on a non-tty we hard-error.
  sp_requested = bool(sharepoint_sites or sharepoint_file_ids)
  if sp_requested:
    # Load persisted Microsoft IDs lazily — only when SharePoint is used, so a
    # normal run never reads the env file or mutates os.environ.
    _source_microsoft_env()
  if sp_requested and not sharepoint_tools._credentials_configured():
    msg = (
        "SharePoint sources were specified but no Microsoft credentials"
        " are configured. Run:\n"
        "  python3 toolbox/enrichment/scripts/setup_sharepoint.py\n"
        "for a one-time interactive walkthrough (registers Entra app +"
        " populates MSAL cache for silent refresh)."
    )
    if sys.stdin.isatty() and sys.stdout.isatty():
      print(msg)
      print()
      try:
        answer = input(
            "Launch setup_sharepoint.py now? [Y/n] (Ctrl+C to abort): "
        ).strip().lower() or "y"
      except (EOFError, KeyboardInterrupt):
        print()
        raise app.UsageError(
            "Aborted — re-run agent_runner.py after setup is complete."
        )
      if answer.startswith("y"):
        # Spawn setup_sharepoint.py in this same Python; on success
        # continue the agent run. On failure / non-zero exit, bail.
        import subprocess  # noqa: PLC0415
        setup_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..",
            "scripts",
            "setup_sharepoint.py",
        )
        rc = subprocess.call([sys.executable, setup_path])
        if rc != 0:
          raise app.UsageError(
              "setup_sharepoint.py exited non-zero — re-run agent_runner.py"
              " once setup is healthy."
          )
        # Pick up the env vars setup_sharepoint.py just wrote to the
        # config file — subprocess env mutations don't propagate to
        # the parent process, so we re-source here.
        _source_microsoft_env()
        if not sharepoint_tools._credentials_configured():
          raise app.UsageError(
              "Setup script claimed success but credentials still don't"
              " look configured — make sure ~/.config/kc_agent/microsoft.env"
              " got written, then re-run agent_runner.py."
          )
      else:
        raise app.UsageError(
            "Re-run after completing SharePoint setup (or remove the"
            " --sharepoint_* flags / SharePoint URLs from --folders/--docs)."
        )
    else:
      raise app.UsageError(msg)

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
            docs=doc_inputs,
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
            glossaries=_GLOSSARIES.value or None,
            output_format=_OUTPUT_FORMAT.value,
            confluence_spaces=confluence_spaces,
            confluence_cql=None,
            confluence_page_ids=confluence_page_ids,
            sharepoint_sites=sharepoint_sites,
            sharepoint_search=None,
            sharepoint_file_ids=sharepoint_file_ids,
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
            output_format=_OUTPUT_FORMAT.value,
            confluence_spaces=confluence_spaces,
            confluence_cql=None,
            confluence_page_ids=confluence_page_ids,
            sharepoint_sites=sharepoint_sites,
            sharepoint_search=None,
            sharepoint_file_ids=sharepoint_file_ids,
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
            doc_inputs,
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
            glossaries=_GLOSSARIES.value or None,
            # HYBRID: passing --dataset alongside --mode=doc makes doc mode ALSO
            # emit a context-overlay entry per table in that dataset (grounded by
            # the same docs). Empty --dataset => plain doc mode.
            dataset=_DATASET.value,
            tables_filter=_TABLES.value,
            include_usage=_INCLUDE_USAGE.value,
            usage_window_days=_USAGE_WINDOW_DAYS.value,
            anonymize_users=_ANONYMIZE_USERS.value,
            usage_scope=_USAGE_SCOPE.value,
            output_format=_OUTPUT_FORMAT.value,
            confluence_spaces=confluence_spaces,
            confluence_cql=None,
            confluence_page_ids=confluence_page_ids,
            sharepoint_sites=sharepoint_sites,
            sharepoint_search=None,
            sharepoint_file_ids=sharepoint_file_ids,
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
