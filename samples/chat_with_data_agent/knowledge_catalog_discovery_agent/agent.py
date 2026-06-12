"""Knowledge Catalog Discovery Agent."""

import os

from google.adk.agents import llm_agent
from google.adk.models import google_llm

from . import tools
from .utils import get_consumer_project, get_knowledge_base_entry_group

consumer_project = get_consumer_project()
GEMINI_MODEL = f"projects/{consumer_project}/locations/global/publishers/google/models/gemini-2.5-flash"

# Paths to the skill files relative to the agent.py location
SKILL_FILE_PATH = os.path.join(os.path.dirname(__file__), 'SKILL.md')
KB_SKILL_FILE_PATH = os.path.join(os.path.dirname(__file__), 'KNOWLEDGE_BASE_SKILL.md')


def load_instruction() -> str:
  """Loads the agent instruction from the appropriate skill file."""
  if get_knowledge_base_entry_group():
    with open(KB_SKILL_FILE_PATH, 'r') as f:
      return f.read()
  with open(SKILL_FILE_PATH, 'r') as f:
    return f.read()


agent_tools = [tools.knowledge_catalog_multi_search]
if get_knowledge_base_entry_group():
  agent_tools.append(tools.knowledge_catalog_knowledge_base_search)


root_agent = llm_agent.Agent(
    model=google_llm.Gemini(model=GEMINI_MODEL),
    name='knowledge_catalog_discovery_agent',
    description=(
        'Searches Knowledge Catalog for data entries based on Natural Language'
        ' user queries.'
    ),
    instruction=load_instruction(),  # Load instruction from file
    tools=agent_tools,
)
