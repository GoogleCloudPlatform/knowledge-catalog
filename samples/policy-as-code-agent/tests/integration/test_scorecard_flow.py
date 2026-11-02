"""Integration tests for the compliance scorecard flow."""

import pytest
from google.adk.agents import Agent
from google.adk.artifacts import InMemoryArtifactService
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from policy_as_code_agent import agent as agent_module


# Mock tools
def mock_get_active_core_policies() -> dict:
    return {"status": "success", "policies": ["Policy A", "Policy B"]}


def mock_generate_compliance_scorecard(
    source_type: str, source_target: str
) -> dict:
    return {
        "status": "success",
        "scorecard": {
            "compliance_score": "100.0%",
            "policies_passed": 2,
            "total_policies": 2,
            "details": [
                {"policy": "Policy A", "status": "Passed"},
                {"policy": "Policy B", "status": "Passed"},
            ],
        },
    }


def create_scorecard_agent() -> Agent:
    mocks = {
        "get_active_core_policies": mock_get_active_core_policies,
        "generate_compliance_scorecard": mock_generate_compliance_scorecard,
    }

    new_tools = []
    for tool in agent_module.root_agent.tools:
        tool_name = getattr(tool, "__name__", None)
        if tool_name and tool_name in mocks:
            mock = mocks[tool_name]
            mock.__name__ = tool_name
            mock.__doc__ = tool.__doc__
            new_tools.append(mock)
        else:
            new_tools.append(tool)

    return Agent(
        name="test_scorecard_agent",
        model="gemini-2.5-flash",
        description=agent_module.root_agent.description,
        instruction=agent_module.root_agent.instruction,
        tools=new_tools,
    )


@pytest.fixture
def runner() -> Runner:
    return Runner(
        app_name="test-scorecard",
        agent=create_scorecard_agent(),
        session_service=InMemorySessionService(),
        artifact_service=InMemoryArtifactService(),
    )


@pytest.mark.asyncio
async def test_scorecard_generation(runner: Runner) -> None:
    """Test the conversational flow for generating a compliance scorecard."""
    user_id = "test-user"
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user_id
    )

    # User asks for scorecard
    input_text = (
        "Generate a compliance scorecard for GCS path gs://bucket/file.jsonl"
    )
    input_content = types.UserContent(input_text)

    response_text = ""
    async for event in runner.run_async(
        user_id=user_id, session_id=session.id, new_message=input_content
    ):
        if event.content:
            for part in event.content.parts:
                if part.text:
                    response_text += part.text

    # Verify response contains scorecard info
    assert "100.0%" in response_text
    assert "Policy A" in response_text
