"""Confluence input: agentic page understanding via the Atlassian Rovo MCP server.

A sibling to github_tools.py: an ADK `LlmAgent` is given Atlassian's hosted
remote MCP server (`https://mcp.atlassian.com/v1/mcp/authv2`) and asked to
explore Confluence on its own — list spaces, run CQL, read pages — then
distill the relevant pages into a set of *Confluence page cards*.

Each card is emitted in the SAME router-descriptor doc shape every mode
already consumes — `{name, url, content, descriptor}` — so the existing
pipelines fold Confluence context in with zero per-mode plumbing, identical
to how GitHub component cards are folded in:

  * doc mode             — cards are appended as neutral per-doc cards and
                           flow into the topic reduce → enumerate → write
                           pipeline, so distinct pages surface as their own
                           KB entries.
  * table / overlay mode — cards join the candidate-document pool the
                           relevance router scores per table, so a runbook
                           or design doc that mentions a table grounds that
                           table's overview.

MCP server wiring:
  * Default — Atlassian's hosted remote MCP at the URL above. Accepts
    third-party MCP clients (unlike Microsoft Agent 365 SharePoint MCP).
  * Auth (env-var path) — see _build_auth_header for the full precedence.
    Briefly:
      - `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` -> personal API token
        (sent as Basic auth — this is what id.atlassian.com mints).
      - `ATLASSIAN_API_TOKEN` alone -> service-account API key (Bearer).
      - `ATLASSIAN_OAUTH_TOKEN` -> raw OAuth bearer (Bearer).
    For any API-token path, your site admin must enable API-token auth on
    the Rovo MCP server settings page.
  * Auth (OAuth-via-mcp-remote path) — point `--mcp_config` at an
    mcp.json that wraps `npx -y mcp-remote@latest <atlassian-mcp-url>`
    over stdio. `mcp-remote` handles the OAuth dance itself and the env
    vars above are not consulted on this path. Recommended for full tool
    catalog access — API-token auth is a documented subset.
  * Override — point at a different MCP server with `--mcp_config` (same
    flag GitHub uses; the file selects by key — Confluence reads the
    `_SERVER_KEY` entry, default `atlassian_remote`).

Failure is non-fatal: if the server can't be reached, the token is
missing/invalid, or the model returns nothing parseable, we log a warning
and return an empty list. A run with `--confluence_space` set therefore
degrades to "no Confluence context" rather than crashing the whole
enrichment.
"""

import base64
import json
import os
import re
import typing as t
import urllib.parse as _urlparse
import uuid

from engine import VertexGemini
from google.adk.agents import llm_agent
from google.adk.runners import InMemoryRunner
from google.genai import types

# Atlassian's hosted remote Rovo MCP server. Accepts third-party MCP clients
# via OAuth 2.1 or (if admin-enabled) API token authentication.
_DEFAULT_REMOTE_URL = "https://mcp.atlassian.com/v1/mcp/authv2"
# Token envs, checked in priority order. API token is the simplest path; OAuth
# token is what `mcp-remote` writes after the interactive consent flow.
_TOKEN_ENVS = ("ATLASSIAN_API_TOKEN", "ATLASSIAN_OAUTH_TOKEN")

# Which server entry to use from a multi-server mcp.json. Defaults so a stock
# mcp.json with a single Atlassian entry under any key still works.
_SERVER_KEY = os.environ.get(
    "KC_ENRICH_CONFLUENCE_MCP_SERVER", "atlassian_remote"
)

# Cap exploration turns. Confluence sites can be huge; this matches GitHub's
# budget and is the hard ceiling on tool-driving turns.
_MAX_EXPLORE_TURNS = 40


# ---------------------------------------------------------------------------
# URL classifier + source partitioner
#
# Lets the user drop Confluence URLs straight into --folders (or --docs)
# alongside Drive / local-markdown entries; agent_runner.py calls
# partition_sources() once before dispatch to lift the Confluence entries
# out into the existing --confluence_space / --confluence_page_ids lists.
# All downstream Drive/local routing in is_local_path() and the modes stays
# unchanged, because by the time they see the lists, Confluence URLs are
# already gone.
# ---------------------------------------------------------------------------

# Modern Cloud URL form: .../wiki/spaces/<KEY>/pages/<ID>/<title-slug>?...
# Also matches .../wiki/spaces/<KEY>/blogposts/<ID>/... (same data model).
_CONFLUENCE_PAGE_PATH_RE = re.compile(
    r"^/wiki/spaces/([^/]+)/(?:pages|blogposts)/(\d+)(?:/|$)", re.IGNORECASE
)
# Space root: .../wiki/spaces/<KEY> or .../wiki/spaces/<KEY>/overview
_CONFLUENCE_SPACE_PATH_RE = re.compile(
    r"^/wiki/spaces/([^/?#]+)(?:/overview)?/?$", re.IGNORECASE
)
# Legacy "display" link: .../wiki/display/<KEY>[/<page-title>]
# Page-by-title can't be resolved to a page ID without an API call; we
# downgrade these to space-level (the agent will pick the page back up
# when scoring titles against the topic).
_CONFLUENCE_DISPLAY_PATH_RE = re.compile(
    r"^/wiki/display/([^/]+)", re.IGNORECASE
)
# Tiny URL: .../wiki/x/<short> — needs a server roundtrip to resolve.
_CONFLUENCE_TINY_PATH_RE = re.compile(r"^/wiki/x/", re.IGNORECASE)
# Old action URL: .../wiki/pages/viewpage.action?pageId=<ID>
_CONFLUENCE_VIEWPAGE_PATH_RE = re.compile(
    r"^/wiki/pages/viewpage\.action$", re.IGNORECASE
)


def classify_confluence_url(s: str) -> dict | None:
  """If `s` looks like a Confluence URL, return its parsed form; else None.

  Returned dicts:
    {'kind': 'page',    'page_id': '<id>', 'space': '<key>' | ''}
    {'kind': 'space',   'space':   '<key>'}
    {'kind': 'unknown', 'raw':     '<original>'}   # short URL / page-by-title

  None means "not Confluence" — the caller routes it to the existing
  Drive / local-markdown logic untouched.
  """
  s = (s or "").strip()
  if not s.lower().startswith(("http://", "https://")):
    return None
  try:
    u = _urlparse.urlparse(s)
  except (ValueError, TypeError):
    return None
  path = u.path or ""
  if "/wiki/" not in path.lower():
    return None

  # 1. Modern page URL — most common, check first.
  m = _CONFLUENCE_PAGE_PATH_RE.match(path)
  if m:
    return {"kind": "page", "space": m.group(1), "page_id": m.group(2)}

  # 2. Old action URL with pageId as a query param.
  if _CONFLUENCE_VIEWPAGE_PATH_RE.match(path):
    qs = _urlparse.parse_qs(u.query)
    pids = qs.get("pageId") or qs.get("pageid")
    if pids:
      return {"kind": "page", "space": "", "page_id": pids[0]}

  # 3. Space root / overview. If overview carries ?homepageId=, prefer the
  #    page hint over the bare space — the user usually copied that URL
  #    because they're pointing at a specific landing page.
  m = _CONFLUENCE_SPACE_PATH_RE.match(path)
  if m:
    qs = _urlparse.parse_qs(u.query)
    homes = qs.get("homepageId") or qs.get("homepageid")
    if homes:
      return {"kind": "page", "space": m.group(1), "page_id": homes[0]}
    return {"kind": "space", "space": m.group(1)}

  # 4. Legacy display URL → space-level (page-by-title can't be resolved).
  m = _CONFLUENCE_DISPLAY_PATH_RE.match(path)
  if m:
    return {"kind": "space", "space": m.group(1)}

  # 5. Tiny URL — needs API resolution.
  if _CONFLUENCE_TINY_PATH_RE.match(path):
    return {"kind": "unknown", "raw": s}

  # /wiki/ in the path but an unrecognized shape — surface but skip.
  return {"kind": "unknown", "raw": s}


def partition_sources(
    entries: list[str] | None,
    confluence_spaces: list[str] | None = None,
    confluence_page_ids: list[str] | None = None,
) -> tuple[list[str], list[str], list[str]]:
  """Split a mixed `--folders`/`--docs` list, lifting Confluence URLs out.

  For each entry:
    - Confluence page URL  → append its page ID to confluence_page_ids.
    - Confluence space URL → append its space key to confluence_spaces.
    - Anything else (Drive URL/ID, local path/file) → keep in the returned
      filtered list, so the existing Drive/local routing handles it.

  Deduplicates against whatever the user already passed via
  --confluence_space / --confluence_page_ids, so a URL plus an explicit
  flag for the same page doesn't cause duplicate work.

  Original lists are NOT mutated; new lists are returned. Returns:
    (filtered_entries, updated_spaces, updated_page_ids)
  """
  filtered: list[str] = []
  spaces = list(confluence_spaces or [])
  pages = list(confluence_page_ids or [])
  seen_spaces = {x.strip() for x in spaces if x and x.strip()}
  seen_pages = {x.strip() for x in pages if x and x.strip()}
  for e in entries or []:
    cls = classify_confluence_url(e)
    if cls is None:
      filtered.append(e)
      continue
    kind = cls.get("kind")
    if kind == "page":
      pid = str(cls.get("page_id", "")).strip()
      if pid and pid not in seen_pages:
        pages.append(pid)
        seen_pages.add(pid)
        print(
            f"[Confluence] 🔗 Resolved {e} → page id {pid}"
            + (f" (space {cls['space']})" if cls.get("space") else ""),
            flush=True,
        )
    elif kind == "space":
      sp = str(cls.get("space", "")).strip()
      if sp and sp not in seen_spaces:
        spaces.append(sp)
        seen_spaces.add(sp)
        print(
            f"[Confluence] 🔗 Resolved {e} → space {sp}",
            flush=True,
        )
    else:
      print(
          f"[Confluence] ⚠️  Could not classify URL {e!r} as a page or"
          " space (likely a tiny URL like .../wiki/x/<short> or a legacy"
          " page-by-title link). Pass --confluence_page_ids=<id> or use"
          " the full /wiki/spaces/<KEY>/pages/<ID>/... URL instead.",
          flush=True,
      )
  return filtered, spaces, pages


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

  Mirrors github_tools._response_text — MCP/ADK wrap tool results in varied
  shapes (a dict with 'result'/'content', a list of content blocks, a bare
  string). We only need the text length to gauge whether real content came
  back, so we stringify defensively.
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
  text_attr = getattr(response, "text", None)
  if isinstance(text_attr, str):
    return text_attr
  return str(response)


def _resolve_token() -> str:
  """Return the first non-empty Atlassian token from the env, or ''."""
  for env in _TOKEN_ENVS:
    v = os.environ.get(env, "").strip()
    if v:
      return v
  return ""


def _build_auth_header() -> dict[str, str]:
  """Build the right Authorization header for the connection's auth mode.

  Three cases, checked in this order (only the built-in HTTP-transport path
  uses this — the --mcp_config / OAuth-via-mcp-remote path doesn't touch
  it, since `mcp-remote` presents the OAuth token to the server itself):

    1. ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN both set
       → personal API token: emit `Basic base64(email:token)`. This is the
         documented header for tokens minted at
         id.atlassian.com/manage-profile/security/api-tokens. Note that
         the Rovo MCP server silently downgrades unrecognized auth to a
         "Teamwork Graph only" tool subset instead of returning 401, so
         getting this exactly right matters.
    2. ATLASSIAN_API_TOKEN set without ATLASSIAN_EMAIL
       → assumed to be a service-account API key: emit `Bearer <token>`.
    3. ATLASSIAN_OAUTH_TOKEN set
       → emit `Bearer <token>` (raw OAuth bearer, for callers that don't
         want to run `mcp-remote` but already hold a token).

  Returns `{}` if none of the above apply (caller short-circuits with a
  warning so we never make an unauthenticated request).
  """
  email = os.environ.get("ATLASSIAN_EMAIL", "").strip()
  api_token = os.environ.get("ATLASSIAN_API_TOKEN", "").strip()
  oauth_token = os.environ.get("ATLASSIAN_OAUTH_TOKEN", "").strip()
  if email and api_token:
    creds = base64.b64encode(f"{email}:{api_token}".encode()).decode()
    return {"Authorization": f"Basic {creds}"}
  if api_token:
    return {"Authorization": f"Bearer {api_token}"}
  if oauth_token:
    return {"Authorization": f"Bearer {oauth_token}"}
  return {}


def _expand_env(value: t.Any) -> t.Any:
  """Recursively expand ${VAR} / $VAR in JSON-loaded values."""
  if isinstance(value, str):
    return os.path.expandvars(value)
  if isinstance(value, list):
    return [_expand_env(v) for v in value]
  if isinstance(value, dict):
    return {k: _expand_env(v) for k, v in value.items()}
  return value


def load_mcp_server_config(config_path: str | None) -> dict:
  """Resolve the Atlassian MCP server launch spec.

  Precedence:
    1. `config_path` flag, else `KC_ENRICH_MCP_CONFIG` env — a JSON file
       shaped like the GitHub sample (`{"mcpServers": {"<key>": {...}}}`).
       `${VAR}` tokens are expanded. The `_SERVER_KEY` entry is selected;
       if absent but the config defines exactly one server, that one is
       used.
    2. Built-in default (no config file): Atlassian's hosted REMOTE server
       at `https://mcp.atlassian.com/v1/mcp/authv2`, authenticated with
       whichever of ATLASSIAN_API_TOKEN / ATLASSIAN_OAUTH_TOKEN is set.

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
      only_key = next(iter(servers))
      print(
          f"[Confluence] ℹ️  MCP config has no '{_SERVER_KEY}'; using its"
          f" only server '{only_key}'.",
          flush=True,
      )
      spec = servers[only_key]
    else:
      raise ValueError(
          f"MCP config '{path}' has no '{_SERVER_KEY}' server (found:"
          f" {sorted(servers)}). Set KC_ENRICH_CONFLUENCE_MCP_SERVER to"
          " the right key."
      )
    if spec.get("url"):
      return {
          "transport": "http",
          "url": spec["url"],
          "headers": spec.get("headers", {}),
      }
    return {
        "transport": "stdio",
        "command": spec["command"],
        "args": spec.get("args", []),
        "env": spec.get("env", {}),
    }
  # Built-in default: hosted remote MCP + auth header from env. See
  # _build_auth_header for the precedence rules (Basic for personal API
  # tokens with ATLASSIAN_EMAIL, Bearer for service-account API keys or
  # raw OAuth tokens). The --mcp_config / mcp-remote OAuth path never
  # reaches this branch.
  return {
      "transport": "http",
      "url": os.environ.get("KC_ENRICH_CONFLUENCE_MCP_URL", _DEFAULT_REMOTE_URL),
      "headers": _build_auth_header(),
  }


def _build_toolset(cfg: dict):
  """Build an ADK McpToolset from a normalized config dict."""
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

  from google.adk.tools.mcp_tool.mcp_session_manager import (
      StdioConnectionParams,
  )
  from mcp import StdioServerParameters

  child_env = {**os.environ, **(cfg.get("env") or {})}
  return McpToolset(
      connection_params=StdioConnectionParams(
          server_params=StdioServerParameters(
              command=cfg["command"],
              args=cfg.get("args", []),
              env=child_env,
          ),
          timeout=120.0,
      )
  )


_EXPLORER_INSTRUCTION = """You are a senior technical writer indexing a Confluence corpus for a metadata-enrichment pipeline. You have tools from the Atlassian Rovo MCP server to bootstrap the site (`getAccessibleAtlassianResources`), browse Confluence (`getConfluenceSpaces`, `getPagesInConfluenceSpace`, `searchConfluenceUsingCql`), and read individual pages (`getConfluencePage`). Use them to UNDERSTAND the relevant pages, then describe each.

SCOPE FOR THIS RUN:
{scope_directive}
FOCUS TOPIC for relevance scoring: {topic}

EXPLORATION STRATEGY — follow this sequence; do NOT stop after only the prep steps:

STEP 0 (always, first): Call `getAccessibleAtlassianResources()` ONCE to get the cloudId for this Atlassian site. EVERY subsequent Confluence tool call MUST pass this cloudId. Tools called without a cloudId, or with a placeholder like `site.atlassian.net`, will fail — do not guess the cloudId.

STEP 1 (if page IDs were provided): For EACH ID, call `getConfluencePage(cloudId=..., pageId=...)`. These are the highest-priority inputs. If page IDs were ALL you were given, skip to OUTPUT after reading them.

STEP 2 (if space keys were provided): For EACH space key:
  a. Call `getConfluenceSpaces(cloudId=..., keys=[<key>])` to look up its numeric spaceId.
  b. Call `getPagesInConfluenceSpace(cloudId=..., spaceId=...)` to enumerate pages. You MUST make this call — listing the space metadata in (a) is NOT enough on its own.
  c. From the returned page list, pick up to 5 whose titles look most relevant to the focus topic.
  d. For EACH picked page, call `getConfluencePage(cloudId=..., pageId=...)` to read it.

STEP 3 (if CQL queries were provided): For EACH query, call `searchConfluenceUsingCql(cloudId=..., cql=...)` and then call `getConfluencePage` on the top results to actually read them.

STEP 4 (optional — only if you have remaining tool budget): When a page you read references child pages of clear relevance, fetch them via `getConfluencePageDescendants` and read the ones that look relevant. Stop at depth 2 from any seed.

STOP RULES — emit OUTPUT and end as soon as ALL of these are true:
  - You have read at least one page via `getConfluencePage`.
  - You have processed every explicit page ID / space / CQL query in scope.
Do NOT make redundant verification calls (e.g. searching CQL for a page you already read). Do NOT keep exploring after the targeted scope is covered.

For EACH page you actually read, emit ONE card with:
  - id: the Confluence page ID (string, as returned by the tool).
  - title: the page title verbatim.
  - space: the space key the page lives in.
  - url: the page's `_links.webui` / `_links.base` URL if present; otherwise an absolute Confluence URL constructed from the site base.
  - summary: ONE sentence describing what the page is about.
  - key_entities: concrete named things mentioned that a data catalog should know — table/dataset names, system names, KPIs, glossary-worthy terms, owning team names, runbook names. Use the exact spellings from the page.
  - content_excerpt: the relevant prose, lightly cleaned. Quote verbatim. Cap at ~6000 chars per page; if longer, prefer sections that mention the focus topic or named data assets.

GROUNDING (CRITICAL — do not hallucinate):
- A card may ONLY be emitted for a page you actually read with the tools.
- NEVER invent pages from the space name, the topic, or your prior knowledge. If the tools returned no content, output [].
- Describe only what the read pages actually contain. Quote identifiers verbatim.

OUTPUT: when done exploring, output ONLY a single JSON array of card objects (no prose before or after, no markdown fence). Keys exactly: id, title, space, url, summary, key_entities (array of strings), content_excerpt (string). If the corpus is empty, unreachable, or your tools returned no content, output [].
"""


def _page_card(card: dict) -> dict:
  """Render one parsed page card into the shared router-descriptor doc shape."""
  page_id = str(card.get("id") or "").strip()
  title = (card.get("title") or "Untitled Confluence page").strip()
  space = (card.get("space") or "").strip()
  url = (card.get("url") or "").strip()
  if not url and page_id:
    # Best-effort fallback when the model omitted the URL.
    url = f"confluence://page/{page_id}"
  summary = (card.get("summary") or "").strip()
  entities = card.get("key_entities") or []
  if isinstance(entities, str):
    entities = [entities]
  entities = [str(e).strip() for e in entities if str(e).strip()]
  excerpt = (card.get("content_excerpt") or "").strip()

  entities_str = ", ".join(entities) if entities else "(none listed)"

  content = (
      f"# {title}\n\n"
      f"**Source:** [Confluence: {space or 'page'} / {title}]({url})\n\n"
      "## Identity\n"
      f"- **Type:** Confluence page\n"
      f"- **Space:** `{space or '(unknown)'}`\n"
      f"- **Page ID:** `{page_id or '(unknown)'}`\n"
      f"- **Summary:** {summary or '(not stated)'}\n\n"
      "## Key Entities\n"
      f"{entities_str}\n\n"
      "## Content\n"
      f"{excerpt or '(no excerpt captured)'}\n"
  )
  descriptor = (
      f"Title: {title}\n"
      f"Summary: {summary or 'Confluence page in space ' + (space or '?')}\n"
      f"Key entities: {entities_str}"
  )
  return {
      "name": title,
      "url": url,
      "content": content,
      "descriptor": descriptor,
  }


def _parse_cards(raw_text: str) -> list[dict]:
  """Leniently parse the explorer agent's JSON array of page cards."""
  text = (raw_text or "").strip()
  if not text:
    return []
  fence = re.match(r"^```(?:json)?\s*\n(.*)\n```$", text, re.S)
  if fence:
    text = fence.group(1).strip()
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


async def gather_confluence_context(
    spaces: list[str] | None,
    cql_queries: list[str] | None,
    page_ids: list[str] | None,
    topic: str,
    model: str,
    usage_acc: dict,
    mcp_config_path: str | None = None,
) -> list[dict]:
  """Agentically explore Confluence and return page cards.

  Returns a list of router-descriptor dicts `{name, url, content, descriptor}`
  (the caller assigns `id`). Always returns a list — on any failure it logs a
  warning and returns `[]` so the enrichment run continues without Confluence
  context.

  Args:
    spaces: optional Confluence space keys to list top-level pages from.
    cql_queries: optional CQL queries to search; e.g.
      `type=page AND label="runbook"`.
    page_ids: optional explicit Confluence page IDs to read.
    topic: the run's focus topic (passed to the agent for relevance scoring).
    model: model name for the exploration agent (typically the run's --model).
    usage_acc: token-usage accumulator (mutated in place).
    mcp_config_path: optional path to an mcp.json describing the server.
  """
  spaces = [s.strip() for s in (spaces or []) if s and s.strip()]
  cql_queries = [q.strip() for q in (cql_queries or []) if q and q.strip()]
  page_ids = [p.strip() for p in (page_ids or []) if p and p.strip()]
  if not (spaces or cql_queries or page_ids):
    return []

  try:
    cfg = load_mcp_server_config(mcp_config_path)
  except (OSError, ValueError, json.JSONDecodeError) as e:
    print(
        f"[Confluence] ⚠️  MCP config error, skipping Confluence source: {e}",
        flush=True,
    )
    return []

  # Built-in default path requires a token; explicit configs may carry their
  # own auth in `headers`, so only warn-and-skip when both are missing.
  if (
      cfg["transport"] == "http"
      and not cfg.get("headers", {}).get("Authorization")
      and not _resolve_token()
  ):
    print(
        "[Confluence] ⚠️  No Atlassian credentials in env (set"
        " ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN for a personal API token,"
        " ATLASSIAN_API_TOKEN alone for a service-account API key, or"
        " ATLASSIAN_OAUTH_TOKEN for a raw OAuth bearer) and no"
        " Authorization header in MCP config — skipping Confluence source.",
        flush=True,
    )
    return []

  scope_lines = []
  if spaces:
    scope_lines.append(f"SPACES: {', '.join(spaces)}")
  if cql_queries:
    scope_lines.append("CQL QUERIES:\n  - " + "\n  - ".join(cql_queries))
  if page_ids:
    scope_lines.append(f"EXPLICIT PAGE IDS: {', '.join(page_ids)}")
  scope_directive = "\n".join(scope_lines) + "\n"

  instruction = _EXPLORER_INSTRUCTION.format(
      scope_directive=scope_directive, topic=topic
  )

  print(
      "[Confluence] 📘 Exploring Confluence via Atlassian Rovo MCP"
      f" ({cfg['transport']}): spaces={spaces or '(none)'},"
      f" cql={len(cql_queries)} query(ies), pages={page_ids or '(none)'}",
      flush=True,
  )

  toolset = None
  try:
    toolset = _build_toolset(cfg)
    agent = llm_agent.LlmAgent(
        name="ConfluenceUnderstandingAgent",
        description=(
            "Explores a Confluence corpus via Atlassian Rovo MCP tools and"
            " emits structured page cards."
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
    kickoff_bits = ["Explore the Confluence scope above and emit the JSON array of page cards."]
    if page_ids:
      kickoff_bits.append(
          f"START by reading every page in EXPLICIT PAGE IDS via"
          " getConfluencePage."
      )
    if spaces:
      kickoff_bits.append(
          "THEN for each space key, list its pages and read the most"
          f" topic-relevant ones for: {topic}."
      )
    if cql_queries:
      kickoff_bits.append(
          "THEN run each CQL query via searchConfluenceUsingCql and read the"
          " top results."
      )
    kickoff = " ".join(kickoff_bits)

    raw_text = ""
    turns = 0
    n_tool_calls = 0
    read_page_ids = set()
    total_read_chars = 0
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
      for fc in event.get_function_calls() or []:
        n_tool_calls += 1
        args = fc.args or {}
        # Atlassian's MCP uses `id` for page reads, `spaceKey` for space lists,
        # `cql` for searches — log them all.
        ident = (
            args.get("id")
            or args.get("pageId")
            or args.get("spaceKey")
            or args.get("cql")
            or ""
        )
        print(
            f"[Confluence]    → tool {fc.name}({_short_args(args)})",
            flush=True,
        )
        if ident and args.get("id"):
          read_page_ids.add(str(args["id"]))
        if ident and args.get("pageId"):
          read_page_ids.add(str(args["pageId"]))
      for fr in event.get_function_responses() or []:
        resp_len = len(_response_text(fr.response))
        total_read_chars += resp_len
        print(f"[Confluence]    ← {fr.name}: {resp_len} chars", flush=True)
      if event.content and event.content.parts:
        for part in event.content.parts:
          if part.text:
            raw_text += part.text
      if turns > _MAX_EXPLORE_TURNS * 4:
        print(
            "[Confluence] ⚠️  Exploration exceeded turn budget; using output"
            " so far.",
            flush=True,
        )
        break
    print(
        f"[Confluence] 🔧 MCP usage: {n_tool_calls} tool call(s),"
        f" {total_read_chars} chars of content read.",
        flush=True,
    )
  except Exception as e:  # pylint: disable=broad-except
    print(
        f"[Confluence] ⚠️  Atlassian MCP exploration failed"
        f" ({type(e).__name__}: {e}) — continuing without Confluence"
        " context.",
        flush=True,
    )
    return []
  finally:
    if toolset is not None:
      try:
        await toolset.close()
      except Exception:  # pylint: disable=broad-except
        pass

  # Hallucination guard: if the tools never returned real content, the
  # model's cards are invented from priors.
  if total_read_chars == 0:
    print(
        "[Confluence] ⛔ The Atlassian MCP server returned NO content"
        f" ({n_tool_calls} tool call(s)). Not emitting any cards (would be"
        " hallucinated). Check: the server is reachable, the token has read"
        " access to these spaces, and the space/CQL/page IDs exist.",
        flush=True,
    )
    return []

  cards = _parse_cards(raw_text)
  if not cards:
    print(
        "[Confluence] ⚠️  No parseable cards returned from exploration.",
        flush=True,
    )
    return []

  # If explicit page IDs were given, drop any card whose id wasn't actually
  # fetched (mirror the github_tools grounding guard). Cards from broader
  # space/CQL exploration are kept regardless — they are tool-grounded by
  # the total_read_chars check above.
  kept, dropped = [], []
  for c in cards:
    cid = str(c.get("id") or "").strip()
    if page_ids and cid and cid not in read_page_ids:
      dropped.append(c)
    else:
      kept.append(c)
  if dropped:
    print(
        f"[Confluence] 🗑️  Dropped {len(dropped)} ungrounded card(s) (page"
        " id not among the ones actually fetched):"
        f" {[d.get('title') for d in dropped]}",
        flush=True,
    )
  if not kept:
    print(
        "[Confluence] ⚠️  All cards were ungrounded — emitting none.",
        flush=True,
    )
    return []

  rendered = [_page_card(c) for c in kept]
  print(
      f"[Confluence] ✅ Derived {len(rendered)} page card(s):"
      f" {[c['name'] for c in rendered]}",
      flush=True,
  )
  return rendered
