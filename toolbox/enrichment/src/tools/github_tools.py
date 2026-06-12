"""Source code input: agentic repo understanding via the GitHub MCP server.

This is the *fourth* input source for the enrichment agent (alongside Google
Docs, a Drive folder, and BigQuery `INFORMATION_SCHEMA` usage). Unlike the
others it is **agentic**: an ADK `LlmAgent` is given the GitHub MCP server's
tools (read repo tree, read file contents, search code, …) and asked to explore
a repository on its own, then distill it into a set of *code component cards*.

Each card is emitted in the SAME router-descriptor doc shape every mode already
consumes — `{id, name, url, content, descriptor}` — so the existing pipelines
fold code context in with zero per-mode plumbing:

  * doc mode             — cards are appended as neutral per-doc cards and flow
                           into the topic reduce → enumerate → write pipeline,
                           so distinct components surface as their own KB
                           entries.
  * table / overlay mode — cards join the candidate-document pool the relevance
                           router scores per table, so e.g. an ETL module that
                           populates a table grounds that table's overview (and
                           any SQL it contains feeds the queries aspect).

MCP server wiring is fully config-driven (no hardcoded server) so it works for
github.com or a GitHub Enterprise server, run locally over stdio or reached as a
remote HTTP endpoint. See `load_mcp_server_config` for the precedence rules and
`samples/enrichment/sample/config/github_mcp.json` for the shape.

Authentication: the GitHub MCP server reads a Personal Access Token from its own
environment (the official server uses `GITHUB_PERSONAL_ACCESS_TOKEN`). We pass
the current process environment through to the spawned server and let the config
declare which env var carries the token, so no secret is ever written to disk by
this tool.

Failure is non-fatal: if the repo can't be reached, the server can't be
launched, or the model returns nothing parseable, we log a warning and return an
empty list. A run with `--repo` set therefore degrades to "no code context"
rather than crashing the whole enrichment.
"""

import json
import os
import re
import typing as t
import uuid

from engine import VertexGemini
from google.adk.agents import llm_agent
from google.adk.runners import InMemoryRunner
from google.genai import types

# GitHub's hosted (remote) MCP server. This is the DEFAULT transport: it needs
# no local binary, just network egress + a token. Override to local stdio by
# selecting a stdio server entry (e.g. KC_ENRICH_GITHUB_MCP_SERVER=github).
_DEFAULT_REMOTE_URL = "https://api.githubcopilot.com/mcp/"
# Stdio launch for the official `github-mcp-server` binary (local fallback).
# `stdio` is the binary's subcommand for MCP-over-stdio.
_DEFAULT_COMMAND = "github-mcp-server"
_DEFAULT_ARGS = ["stdio"]
# The official server's token env var. The config may point at a different one
# (e.g. for a GHE wrapper) via the server entry's `env` block.
_DEFAULT_TOKEN_ENV = "GITHUB_PERSONAL_ACCESS_TOKEN"

# Which server entry to use from a multi-server mcp.json. Defaults to the remote
# entry so no local server is needed; override with KC_ENRICH_GITHUB_MCP_SERVER
# (e.g. =github for the local stdio binary). If the named key is absent but the
# config has exactly one server, that one is used (see load_mcp_server_config).
_SERVER_KEY = os.environ.get("KC_ENRICH_GITHUB_MCP_SERVER", "github_remote")

# Cap the agent's exploration so a huge monorepo can't run away. The agent is
# told to budget its reads; this is the hard ceiling on tool-driving turns.
_MAX_EXPLORE_TURNS = 40


def _short_args(args: dict) -> str:
  """Compact one-line rendering of tool-call args for logging."""
  parts = []
  for k, v in (args or {}).items():
    s = str(v)
    if len(s) > 60:
      s = s[:57] + "..."
    parts.append(f"{k}={s}")
  return ", ".join(parts)


def _response_text(response: t.Any) -> str:
  """Best-effort extraction of textual content from an MCP tool response.

  MCP/ADK wrap tool results in varied shapes (a dict with 'result'/'content',
  a list of content blocks with 'text', or a bare string). We only need the
  length/text to gauge whether real content came back, so we stringify
  defensively.
  """
  if response is None:
    return ""
  if isinstance(response, str):
    return response
  if isinstance(response, dict):
    for key in ("text", "content", "result", "output"):
      if key in response:
        return _response_text(response[key])
    return str(response)
  if isinstance(response, (list, tuple)):
    return "".join(_response_text(x) for x in response)
  # genai/MCP content blocks often expose `.text`.
  text_attr = getattr(response, "text", None)
  if isinstance(text_attr, str):
    return text_attr
  return str(response)


def parse_repo(repo: str) -> tuple[str, str]:
  """`owner/name` or a github URL -> (owner, name). Raises on un-parseable."""
  s = (repo or "").strip()
  if not s:
    raise ValueError("empty repo")
  # SSH scp-like form: git@github.com:owner/name(.git) -> normalize the ':'.
  m = re.match(r"^[^@/]+@[^:/]+:(.+)$", s)
  if m:
    s = m.group(1)
  # Full URL form: https://github.com/owner/name(.git)(/...)
  m = re.search(r"github\.[^/]+/([^/]+)/([^/#?]+)", s)
  if m:
    owner, name = m.group(1), m.group(2)
  else:
    parts = [p for p in s.split("/") if p]
    if len(parts) < 2:
      raise ValueError(
          f"--repo must be `owner/name` or a github URL (got '{repo}')."
      )
    owner, name = parts[-2], parts[-1]
  return owner, name.removesuffix(".git")


def _expand_env(value: t.Any) -> t.Any:
  """Recursively expand ${VAR} / $VAR in strings within a JSON-loaded value."""
  if isinstance(value, str):
    return os.path.expandvars(value)
  if isinstance(value, list):
    return [_expand_env(v) for v in value]
  if isinstance(value, dict):
    return {k: _expand_env(v) for k, v in value.items()}
  return value


def load_mcp_server_config(config_path: str | None) -> dict:
  """Resolve the GitHub MCP server launch spec.

  Precedence:
    1. `config_path` flag, else `KC_ENRICH_MCP_CONFIG` env — a JSON file shaped
       like the sample (`{"mcpServers": {"<key>": {...}}}`). `${VAR}` tokens are
       expanded from the environment. The `_SERVER_KEY` entry is selected; if
       that key is absent but the config defines exactly one server, that one is
       used (so a single-server mcp.json under any key still works).
    2. Built-in default (no config file): GitHub's hosted REMOTE server over
       HTTP, authenticated with `GITHUB_PERSONAL_ACCESS_TOKEN` from the
       environment — no local binary required.

  Returns a normalized dict, one of:
    * stdio:  {"transport": "stdio", "command", "args", "env"}
    * http:   {"transport": "http",  "url", "headers"}
  """
  path = config_path or os.environ.get("KC_ENRICH_MCP_CONFIG", "")
  if path:
    with open(os.path.expanduser(path)) as f:
      raw = _expand_env(json.load(f))
    servers = raw.get("mcpServers", raw)
    if _SERVER_KEY in servers:
      spec = servers[_SERVER_KEY]
    elif len(servers) == 1:
      # Single-server config: use it regardless of its key name.
      only_key = next(iter(servers))
      print(
          f"[Code] ℹ️  MCP config has no '{_SERVER_KEY}'; using its only"
          f" server '{only_key}'.",
          flush=True,
      )
      spec = servers[only_key]
    else:
      raise ValueError(
          f"MCP config '{path}' has no '{_SERVER_KEY}' server (found:"
          f" {sorted(servers)}). Set KC_ENRICH_GITHUB_MCP_SERVER to the right"
          " key."
      )
    if spec.get("url"):
      return {
          "transport": "http",
          "url": spec["url"],
          "headers": spec.get("headers", {}),
      }
    return {
        "transport": "stdio",
        "command": spec.get("command", _DEFAULT_COMMAND),
        "args": spec.get("args", list(_DEFAULT_ARGS)),
        "env": spec.get("env", {}),
    }
  # Built-in default (no config file): remote HTTP server, no local binary.
  token = os.environ.get(_DEFAULT_TOKEN_ENV, "")
  return {
      "transport": "http",
      "url": os.environ.get("KC_ENRICH_GITHUB_MCP_URL", _DEFAULT_REMOTE_URL),
      "headers": {"Authorization": f"Bearer {token}"},
  }


def _resolve_command(command: str) -> str:
  """Resolve a bare server command to an absolute path.

  `go install` drops the binary in $GOBIN (or $GOPATH/bin, default ~/go/bin),
  which is frequently NOT on PATH in the shell that launches the agent/webapp.
  Rather than force the user to edit PATH, we fall back to those well-known Go
  bin dirs when a bare command isn't found on PATH. Commands given as an
  explicit path (containing a separator) are returned untouched.
  """
  import shutil

  if not command or os.sep in command:
    return command
  found = shutil.which(command)
  if found:
    return found
  candidates = []
  gobin = os.environ.get("GOBIN")
  if gobin:
    candidates.append(os.path.join(gobin, command))
  gopath = os.environ.get("GOPATH") or os.path.expanduser("~/go")
  candidates.append(os.path.join(gopath, "bin", command))
  candidates.append(os.path.expanduser(f"~/go/bin/{command}"))
  for cand in candidates:
    if os.path.isfile(cand) and os.access(cand, os.X_OK):
      print(f"[Code] ℹ️  Resolved MCP server '{command}' -> {cand}", flush=True)
      return cand
  return command  # leave as-is; the launch error will be clear


def _build_toolset(cfg: dict):
  """Build an ADK McpToolset from a normalized config dict."""
  from google.adk.tools.mcp_tool.mcp_session_manager import (
      StdioConnectionParams,
  )
  from google.adk.tools.mcp_tool.mcp_toolset import McpToolset

  if cfg["transport"] == "http":
    from google.adk.tools.mcp_tool.mcp_session_manager import (
        StreamableHTTPConnectionParams,
    )

    return McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url=cfg["url"], headers=cfg.get("headers", {})
        )
    )

  from mcp import StdioServerParameters

  # The spawned server inherits our environment (so ADC, PATH, etc. survive),
  # overlaid with the config's `env` block — which is where the PAT lives.
  child_env = {**os.environ, **(cfg.get("env") or {})}
  return McpToolset(
      connection_params=StdioConnectionParams(
          server_params=StdioServerParameters(
              command=_resolve_command(cfg["command"]),
              args=cfg.get("args", []),
              env=child_env,
          ),
          timeout=120.0,
      )
  )


_EXPLORER_INSTRUCTION = """You are a senior software architect creating a structured map of a GitHub repository for a metadata-enrichment pipeline. You have tools to browse the repository (list the file tree, read file contents, search code). Use them to UNDERSTAND the codebase, then describe it.

REPOSITORY: {owner}/{repo}
DEFAULT OWNER/REPO for every tool call: owner=`{owner}`, repo=`{repo}`.
{ref_directive}{scope_directive}
EXPLORATION STRATEGY (be efficient — you have a limited tool budget):
1. FIRST call the tree/list tool on the SCOPE ROOT path above (not on file paths) to see what is actually there. Every file path you read MUST start with the scope root.
2. Read the README and any docs WITHIN the scope root first to learn its purpose.
3. Read build/manifest/config files within the scope root (e.g. package.json, pyproject.toml, go.mod, BUILD, Dockerfile, requirements.txt) to learn the tech stack, entry points, and dependencies.
4. Read the MOST IMPORTANT source files for each major component under the scope root — entry points, core modules, public interfaces, data models, schema/migration files. Do NOT read every file; sample enough to understand each component faithfully.

THEN identify the distinct LOGICAL COMPONENTS found UNDER THE SCOPE ROOT — a component is a coherent module, package, service, library, CLI, or subsystem a reader would want documented as its own unit. Aim for the natural granularity of the project (typically 3-15 components); do not over-split tightly-coupled files or lump unrelated subsystems together.

For EACH component, derive:
  - name: a clear human-readable name (Title Case).
  - path: the primary directory or file path, as a FULL repo-relative path including the scope-root prefix (e.g. `toolbox/enrichment/src`, not just `src`).
  - purpose: ONE sentence on what it does.
  - key_entities: the concrete named things it defines or references that a catalog should know — exported classes/functions, public APIs/endpoints, CLI commands, config keys, env vars, data models, and especially any DATA ASSETS the code reads or writes (BigQuery tables/columns, dataset names, topics, file paths). Be specific and use the exact spellings from the code.
  - details: a dense Markdown description (a few paragraphs or bullets) covering responsibilities, architecture, key interfaces, important data flows, dependencies, and any SQL queries or table references found in the code (quote them).
  - languages: the main languages used.
  - evidence_paths: the list of ACTUAL repo file paths (full repo-relative) you OPENED and read to derive this component. Every component MUST cite at least one file you actually read.

GROUNDING (CRITICAL — do not hallucinate):
- A component may ONLY be reported if you actually READ one or more real files belonging to it with the tools. List those files in evidence_paths.
- NEVER infer or invent components from the repository name, the topic, common project conventions, or your prior knowledge. If the tool results don't show it, it does not exist.
- If your tool calls returned errors or no content, do NOT guess — output an empty array [].
- Describe only what the files you read actually contain. Quote real identifiers, paths, and SQL verbatim.

OUTPUT: when done exploring, output ONLY a single JSON array of component objects (no prose before or after, no markdown fence). Each object has exactly the keys: name, path, purpose, key_entities (array of strings), details (string), languages (array of strings), evidence_paths (array of strings). If the repository is empty, unreadable, or your tools returned no content, output [].
"""


def _component_card(owner: str, repo: str, ref: str, comp: dict) -> dict:
  """Render one parsed component into the shared router-descriptor doc shape."""
  name = (comp.get("name") or "Unnamed component").strip()
  path = (comp.get("path") or "").strip().lstrip("/")
  purpose = (comp.get("purpose") or "").strip()
  entities = comp.get("key_entities") or []
  if isinstance(entities, str):
    entities = [entities]
  entities = [str(e).strip() for e in entities if str(e).strip()]
  details = (comp.get("details") or "").strip()
  languages = comp.get("languages") or []
  if isinstance(languages, str):
    languages = [languages]
  languages = [str(l).strip() for l in languages if str(l).strip()]
  evidence = comp.get("evidence_paths") or []
  if isinstance(evidence, str):
    evidence = [evidence]
  evidence = [str(e).strip().lstrip("/") for e in evidence if str(e).strip()]

  ref_seg = ref or "HEAD"
  if path:
    url = f"https://github.com/{owner}/{repo}/tree/{ref_seg}/{path}"
  else:
    url = f"https://github.com/{owner}/{repo}"

  entities_str = ", ".join(entities) if entities else "(none listed)"
  lang_str = ", ".join(languages) if languages else "n/a"

  # Full card — used as the routed-document content (table/overlay) and as a
  # neutral per-doc card (doc mode). Mirrors the per-doc summarizer card shape.
  content = (
      f"# {name}\n\n"
      f"**Source:** [{owner}/{repo}: {path or name}]({url})\n\n"
      "## Identity\n"
      f"- **Type:** source-code component ({owner}/{repo})\n"
      f"- **Path:** `{path or '(repo root)'}`\n"
      f"- **Languages:** {lang_str}\n"
      f"- **Purpose:** {purpose or '(not stated)'}\n\n"
      "## Key Entities\n"
      f"{entities_str}\n\n"
      "## Details\n"
      f"{details or '(no further detail extracted)'}\n"
      + (
          "\n## Source Files Read\n"
          + "\n".join(f"- `{e}`" for e in evidence)
          + "\n"
          if evidence
          else ""
      )
  )

  # Compact descriptor — what the relevance router scores. Matches the shape
  # emitted by engine.create_doc_summarizer_runner (Title/Summary/Key entities).
  descriptor = (
      f"Title: {name}\nSummary:"
      f" {purpose or 'Source-code component of ' + owner + '/' + repo}\nKey"
      f" entities: {entities_str}"
  )

  return {
      "name": name,
      "url": url,
      "content": content,
      "descriptor": descriptor,
  }


def _parse_components(raw_text: str) -> list[dict]:
  """Leniently parse the explorer agent's JSON array of components."""
  text = (raw_text or "").strip()
  if not text:
    return []
  # Strip a ```json / ``` fence if the model wrapped its output.
  fence = re.match(r"^```(?:json)?\s*\n(.*)\n```$", text, re.S)
  if fence:
    text = fence.group(1).strip()
  # Fall back to the outermost [...] span if there's stray prose around it.
  if not text.startswith("["):
    m = re.search(r"\[.*\]", text, re.S)
    if m:
      text = m.group(0)
  try:
    data = json.loads(text)
  except (ValueError, json.JSONDecodeError):
    return []
  if not isinstance(data, list):
    return []
  return [c for c in data if isinstance(c, dict)]


async def gather_repo_context(
    repo: str,
    ref: str,
    subdir: str,
    topic: str,
    model: str,
    usage_acc: dict,
    mcp_config_path: str | None = None,
) -> list[dict]:
  """Agentically explore a GitHub repo and return code component cards.

  Returns a list of router-descriptor dicts `{name, url, content, descriptor}`
  (the caller assigns `id`). Always returns a list — on any failure it logs a
  warning and returns `[]` so the enrichment run continues without code context.

  Args:
    repo: `owner/name` or a github URL.
    ref: optional branch/tag/sha (empty = the repo's default branch).
    subdir: optional path prefix to scope the exploration.
    topic: the run's focus topic (passed to the agent for relevance).
    model: the model name for the exploration agent (the user's --model).
    usage_acc: token-usage accumulator (mutated in place).
    mcp_config_path: optional path to an mcp.json describing the server.
  """
  try:
    owner, name = parse_repo(repo)
  except ValueError as e:
    print(f"[Code] ⚠️  Skipping repo source: {e}", flush=True)
    return []

  try:
    cfg = load_mcp_server_config(mcp_config_path)
  except (OSError, ValueError, json.JSONDecodeError) as e:
    print(f"[Code] ⚠️  MCP config error, skipping repo source: {e}", flush=True)
    return []

  ref = (ref or "").strip()
  subdir = (subdir or "").strip().strip("/")
  ref_note = f" (ref: {ref})" if ref else ""
  # Hard directives baked into the instruction. The subdir scope is the key
  # lever: without an explicit "treat this as the root, never read outside it"
  # constraint the model tends to explore the repo root and ignore the subdir.
  if ref:
    ref_directive = (
        f"REF: pass `{ref}` as the branch/ref/sha argument to EVERY tool call"
        " (do not read the default branch).\n"
    )
  else:
    ref_directive = ""
  if subdir:
    scope_directive = (
        f"SCOPE ROOT (MANDATORY): `{subdir}`. Treat `{subdir}` as the root of"
        " your exploration. ONLY list, read, and describe paths that start with"
        f" `{subdir}/` (or `{subdir}` itself). Do NOT read files outside it"
        " (e.g. the repo root README, top-level configs) — they are out of"
        " scope. If a tool returns the repo root, immediately re-call it with"
        f" the path `{subdir}`.\n"
    )
  else:
    scope_directive = (
        "SCOPE ROOT: the entire repository (no subdirectory filter).\n"
    )
  instruction = _EXPLORER_INSTRUCTION.format(
      owner=owner,
      repo=name,
      ref_directive=ref_directive,
      scope_directive=scope_directive,
  )

  print(
      f"[Code] 🐙 Exploring {owner}/{name}{ref_note}"
      f"{(' subdir=' + subdir) if subdir else ''} via GitHub MCP"
      f" ({cfg['transport']})...",
      flush=True,
  )

  toolset = None
  try:
    toolset = _build_toolset(cfg)
    agent = llm_agent.LlmAgent(
        name="CodeUnderstandingAgent",
        description=(
            "Explores a GitHub repository via MCP tools and emits structured"
            " code component cards."
        ),
        model=VertexGemini(model=model),
        instruction=instruction,
        tools=[toolset],
    )
    runner = InMemoryRunner(agent=agent)
    user_id = str(uuid.uuid4())
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user_id
    )
    scope_reminder = (
        f" START by listing the tree at path `{subdir}` and confine ALL reads"
        f" to paths under `{subdir}`."
        if subdir
        else ""
    )
    kickoff = (
        f"Explore the repository {owner}/{name} and produce the JSON array of"
        " code component cards. Focus topic for relevance:"
        f" {topic}.{scope_reminder}"
    )
    raw_text = ""
    turns = 0
    n_tool_calls = 0
    read_paths = set()  # paths the agent actually fetched content for
    total_read_chars = 0  # total chars of real file content the tools returned
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session.id,
        new_message=types.Content(
            role="user", parts=[types.Part.from_text(text=kickoff)]
        ),
    ):
      turns += 1
      usage = getattr(event, "usage_metadata", None)
      if usage and usage_acc is not None:
        usage_acc["input"] += getattr(usage, "prompt_token_count", 0) or 0
        usage_acc["output"] += getattr(usage, "candidates_token_count", 0) or 0
      # Visibility into what the agent actually did with the MCP tools. Without
      # this, a silently-failing server looks identical to a real exploration —
      # the model just hallucinates components from the repo name. We log each
      # call and tally how much real content came back.
      for fc in event.get_function_calls() or []:
        n_tool_calls += 1
        args = fc.args or {}
        path_arg = (
            args.get("path")
            or args.get("file_path")
            or args.get("filepath")
            or args.get("tree_sha")
            or ""
        )
        print(
            f"[Code]    → tool {fc.name}({_short_args(args)})",
            flush=True,
        )
        if path_arg:
          read_paths.add(str(path_arg))
      for fr in event.get_function_responses() or []:
        resp_len = len(_response_text(fr.response))
        total_read_chars += resp_len
        print(f"[Code]    ← {fr.name}: {resp_len} chars", flush=True)
      if event.content and event.content.parts:
        for part in event.content.parts:
          if part.text:
            raw_text += part.text
      if turns > _MAX_EXPLORE_TURNS * 4:  # events ≈ several per turn
        print(
            "[Code] ⚠️  Exploration exceeded turn budget; using output so far.",
            flush=True,
        )
        break
    print(
        f"[Code] 🔧 MCP usage: {n_tool_calls} tool call(s),"
        f" {total_read_chars} chars of content read.",
        flush=True,
    )
  except Exception as e:  # pylint: disable=broad-except
    # MCP launch / auth / network failures all land here. Non-fatal by design.
    print(
        f"[Code] ⚠️  GitHub MCP exploration failed ({type(e).__name__}: {e}) —"
        " continuing without code context.",
        flush=True,
    )
    return []
  finally:
    if toolset is not None:
      try:
        await toolset.close()
      except Exception:  # pylint: disable=broad-except
        pass

  # Hallucination guard: if the tools never returned real file content, any
  # "components" the model emitted are invented from its priors (this is what
  # produced the bogus 'Image Generation Utility' / 'Slack Notification
  # Utility'). Refuse them rather than poison the enrichment.
  if total_read_chars == 0:
    print(
        "[Code] ⛔ The GitHub MCP server returned NO file content"
        f" ({n_tool_calls} tool call(s)). Not emitting any components (would be"
        " hallucinated). Check: the server is reachable, the token has read"
        " access to this repo, and the repo/ref/subdir exist.",
        flush=True,
    )
    return []

  components = _parse_components(raw_text)
  if not components:
    print(
        "[Code] ⚠️  No parseable components returned from repo exploration.",
        flush=True,
    )
    return []

  # Drop components not backed by a file the agent actually read. A component is
  # kept only if one of its evidence_paths matches a fetched path (substring
  # either way, to tolerate trailing-file vs directory granularity). If the
  # model omitted evidence_paths entirely we keep the component but flag it.
  kept, dropped = [], []
  for c in components:
    ev = c.get("evidence_paths") or []
    if isinstance(ev, str):
      ev = [ev]
    ev = [str(p).strip().lstrip("/") for p in ev if str(p).strip()]
    if not ev:
      kept.append(c)  # no claim to verify; keep but it won't show evidence
      continue
    grounded = any(any(e in rp or rp in e for rp in read_paths) for e in ev)
    (kept if grounded else dropped).append(c)
  if dropped:
    print(
        f"[Code] 🗑️  Dropped {len(dropped)} ungrounded component(s) (no read"
        f" file matched their evidence): {[d.get('name') for d in dropped]}",
        flush=True,
    )
  if not kept:
    print(
        "[Code] ⚠️  All components were ungrounded — emitting none.", flush=True
    )
    return []

  cards = [_component_card(owner, name, ref, c) for c in kept]
  print(
      f"[Code] ✅ Derived {len(cards)} code component(s) from {owner}/{name}:"
      f" {[c['name'] for c in cards]}",
      flush=True,
  )
  return cards
