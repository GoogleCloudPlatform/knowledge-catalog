"""Chat with Data Agent using OneMCP for BigQuery and Dataplex."""

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

credentials, _ = google.auth.default(
    scopes=[CLOUD_PLATFORM_SCOPE], quota_project_id=consumer_project
)
credentials.refresh(google.auth.transport.requests.Request())
oauth_token = credentials.token

auth_headers = {
    "Authorization": f"Bearer {oauth_token}",
    "X-Goog-User-Project": consumer_project,
}


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
  return content + f"\n\nUse Consumer Project ID: {project_id} for billing or running queries"


bigquery_mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url=BIGQUERY_MCP_ENDPOINT,
        headers=auth_headers,
    )
)

dataplex_mcp_toolset = McpToolset(
    connection_params=StreamableHTTPConnectionParams(
        url=DATAPLEX_MCP_ENDPOINT,
        headers=auth_headers,
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
