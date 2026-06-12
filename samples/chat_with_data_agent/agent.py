"""Chat with Data Agent using OneMCP for BigQuery and Dataplex."""

import asyncio
import os
import sys

# Ensure current directory is in sys.path so discovery_agent can be imported
curr_dir = os.path.dirname(os.path.abspath(__file__))
if curr_dir not in sys.path:
  sys.path.insert(0, curr_dir)

from google.adk.agents.llm_agent import LlmAgent
from google.adk.models import google_llm
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
import google.auth
import google.auth.transport.requests
import httpx

try:
  from .knowledge_catalog_discovery_agent.agent import root_agent as discovery_agent
  from .utils import get_consumer_project
except ImportError:
  from knowledge_catalog_discovery_agent.agent import root_agent as discovery_agent
  from utils import get_consumer_project

consumer_project = get_consumer_project()
GEMINI_MODEL = f"projects/{consumer_project}/locations/global/publishers/google/models/gemini-2.5-flash"

BIGQUERY_MCP_ENDPOINT = "https://bigquery.googleapis.com/mcp"
DATAPLEX_MCP_ENDPOINT = "https://dataplex.googleapis.com/mcp"
CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

# Write-only mode (opt-in via env var). When CHAT_AGENT_WRITE_ONLY is truthy,
# `execute_sql_readonly` is hidden from the BigQuery toolset and the agent
# instruction is augmented to direct the model to emit SQL in a fenced block
# instead of executing it. Useful for offline eval where you want to isolate
# planning quality from BigQuery MCP execution; not recommended for end-user
# chat where actual query results are expected.
WRITE_ONLY_MODE = os.environ.get("CHAT_AGENT_WRITE_ONLY", "").lower() in (
    "1", "true", "yes", "on"
)
_WRITE_ONLY_GUIDELINES = (
    "\n\n## Write-only mode (CHAT_AGENT_WRITE_ONLY=1 is set):\n"
    "- The `execute_sql_readonly` tool is **not available** in this build.\n"
    "- When you would normally run a query, instead emit the complete SQL\n"
    "  inside a fenced ```sql block in your text response and stop.\n"
    "- Always use fully-qualified BigQuery table names in the form\n"
    "  `project.dataset.table` so the table is unambiguously identified.\n"
    "- Do not apologise for not executing — that is the intended behaviour.\n"
    "- You may still use BigQuery schema/list tools (e.g. `get_table_info`,\n"
    "  `list_table_ids`) to inspect tables before writing the SQL.\n"
)

# Credentials object stays in module scope; the httpx event hook below calls
# .refresh() on it lazily before each MCP request so the Bearer token never
# goes stale mid-session.
credentials, _ = google.auth.default(
    scopes=[CLOUD_PLATFORM_SCOPE], quota_project_id=consumer_project
)
credentials.refresh(google.auth.transport.requests.Request())


async def _refresh_auth_on_request(request: httpx.Request) -> None:
  """httpx async event hook: ensure the Authorization header is a live token.

  Without this hook, the Bearer token captured at module-import time expires
  after ~60 minutes and every subsequent MCP call returns 401 Unauthorized
  (surfaced by the ADK MCP layer as `MCP session connection lost`).
  """
  if not credentials.valid:
    # google-auth refresh is sync; offload to a thread to avoid blocking loop.
    await asyncio.to_thread(
        credentials.refresh, google.auth.transport.requests.Request()
    )
  request.headers["Authorization"] = f"Bearer {credentials.token}"
  # X-Goog-User-Project is set via static headers below; backfill here only
  # if a downstream caller stripped it.
  if "X-Goog-User-Project" not in request.headers:
    request.headers["X-Goog-User-Project"] = consumer_project


def make_mcp_http_client(
    headers: dict | None = None,
    timeout: httpx.Timeout | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.AsyncClient:
  """httpx client factory passed to McpToolset.

  Wraps the default MCP client with the refresh hook so every request gets a
  live OAuth Bearer token regardless of session age.
  """
  return httpx.AsyncClient(
      headers=headers,
      timeout=timeout if timeout is not None else httpx.Timeout(30.0),
      auth=auth,
      follow_redirects=True,
      event_hooks={"request": [_refresh_auth_on_request]},
  )


# Static headers carry only non-rotating values. The Bearer token is injected
# by _refresh_auth_on_request right before each request.
static_headers = {"X-Goog-User-Project": consumer_project}


# Path to the skill file relative to the agent.py location
SKILL_FILE_PATH = os.path.join(os.path.dirname(__file__), "SKILL.md")


def load_instruction(project_id: str) -> str:
  """Loads the agent instruction from the SKILL.md file."""
  try:
    with open(SKILL_FILE_PATH, "r") as f:
      content = f.read()
  except FileNotFoundError:
    content = (
        "You are the Chat with Data Agent. Discover data assets using the"
        " discovery sub-agent and explore/query data using BigQuery and"
        " Dataplex OneMCP tools."
    )
  if WRITE_ONLY_MODE:
    content += _WRITE_ONLY_GUIDELINES
  return content + f"\n\nUse Consumer Project ID: {project_id} for billing or running queries"


bigquery_mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url=BIGQUERY_MCP_ENDPOINT,
        headers=static_headers,
        httpx_client_factory=make_mcp_http_client,
    ),
    # In write-only mode, suppress execute_sql_readonly so the agent must emit
    # SQL as text instead of running it. No-op otherwise.
    tool_filter=(
        (lambda tool, ctx=None: tool.name != "execute_sql_readonly")
        if WRITE_ONLY_MODE else None
    ),
)

dataplex_mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url=DATAPLEX_MCP_ENDPOINT,
        headers=static_headers,
        httpx_client_factory=make_mcp_http_client,
    ),
    tool_filter=lambda tool, ctx=None: tool.name != "search_entries",
)

agent_tools = [
    AgentTool(discovery_agent),
    bigquery_mcp_toolset,
    dataplex_mcp_toolset,
]

root_agent = LlmAgent(
    model=google_llm.Gemini(model=GEMINI_MODEL),
    name="chat_with_data_agent",
    description=(
        "An intelligent agent that discovers data assets using the Knowledge"
        " Catalog Discovery Agent tool and answers inquiries using BigQuery"
        " and Dataplex OneMCP tools."
    ),
    instruction=load_instruction(consumer_project),
    tools=agent_tools,
)
