from __future__ import annotations

from importlib import resources

from google.adk import Agent
from google.adk.tools import FunctionTool

from reference_agent.tools.bundle_tools import read_existing_doc, write_concept_doc
from reference_agent.tools.source_tools import (
    list_concepts,
    read_concept_raw,
    sample_rows,
)
from reference_agent.tools.web_tools import fetch_url

DEFAULT_MODEL = "gemini-flash-latest"


def _load_prompt(filename: str) -> str:
    return (
        resources.files("reference_agent.prompts")
        .joinpath(filename)
        .read_text(encoding="utf-8")
    )


def build_bq_agent(model: str = DEFAULT_MODEL) -> Agent:
    return Agent(
        name="okf_bq_reference_agent",
        model=model,
        instruction=_load_prompt("reference_instruction.md"),
        tools=[
            FunctionTool(list_concepts),
            FunctionTool(read_concept_raw),
            FunctionTool(sample_rows),
            FunctionTool(read_existing_doc),
            FunctionTool(write_concept_doc),
        ],
    )


def build_web_agent(model: str = DEFAULT_MODEL) -> Agent:
    return Agent(
        name="okf_web_ingestion_agent",
        model=model,
        instruction=_load_prompt("web_ingestion_instruction.md"),
        tools=[
            FunctionTool(list_concepts),
            FunctionTool(read_concept_raw),
            FunctionTool(read_existing_doc),
            FunctionTool(write_concept_doc),
            FunctionTool(fetch_url),
        ],
    )
