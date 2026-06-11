"""Knowledge Catalog Discovery Agent."""

import os

from google.adk.agents import llm_agent
from google.adk.models import google_llm

from . import tools
from .utils import get_consumer_project

consumer_project = get_consumer_project()
GEMINI_MODEL = f"projects/{consumer_project}/locations/global/publishers/google/models/gemini-2.5-flash"

# Path to the skill file relative to the agent.py location
SKILL_FILE_PATH = os.path.join(os.path.dirname(__file__), 'SKILL.md')


def load_instruction() -> str:
  """Loads the agent instruction from the SKILL.md file."""
  with open(SKILL_FILE_PATH, 'r') as f:
    return f.read()


root_agent = llm_agent.Agent(
    model=google_llm.Gemini(model=GEMINI_MODEL),
    name='knowledge_catalog_discovery_agent',
    description=(
        'Searches Knowledge Catalog for data entries based on Natural Language'
        ' user queries.'
    ),
    instruction=load_instruction(),  # Load instruction from file
    tools=[
        tools.knowledge_catalog_multi_search,
    ],
)
