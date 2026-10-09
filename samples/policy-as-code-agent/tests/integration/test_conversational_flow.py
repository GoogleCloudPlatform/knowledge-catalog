"""Integration tests for the conversational flow of the policy-as-code agent."""

import pytest
from google.adk.agents import Agent
from google.adk.artifacts import InMemoryArtifactService
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from policy_as_code_agent import agent as agent_module

# --- Mock Tools ---


def mock_find_policy_in_memory(query: str, source: str, **kwargs) -> dict:
    """Mock finding a policy."""
    return {"status": "not_found", "message": "No policy found (mock)."}


def mock_generate_policy_code_from_gcs(query: str, gcs_uri: str) -> dict:
    """Mock generating policy code."""
    return {
        "status": "success",
        "policy_code": "def check_policy(metadata):\n    return []",
    }


def mock_save_policy_to_memory(
    natural_language_query: str, policy_code: str, source: str, **kwargs
) -> dict:
    """Mock saving policy."""
    return {"status": "success", "policy_id": "mock_id", "version": 1}


def mock_run_policy_from_gcs(policy_code: str, gcs_uri: str, **kwargs) -> dict:
    """Mock running policy."""
    return {
        "status": "success",
        "report": {
            "violations_found": True,
            "violations": [{"violation": "Mock violation"}],
            "message": "Mock run complete.",
        },
    }


# Helper to create a test agent with mocked tools
def create_test_agent() -> Agent:
    # We need to preserve the original tool names so the LLM knows what to call
    # based on the instructions.

    # Create a mapping of original tool names to mock functions
    mocks = {
        "find_policy_in_memory": mock_find_policy_in_memory,
        "generate_policy_code_from_gcs": mock_generate_policy_code_from_gcs,
        "save_policy_to_memory": mock_save_policy_to_memory,
        "run_policy_from_gcs": mock_run_policy_from_gcs,
    }

    new_tools = []
    for tool in agent_module.root_agent.tools:
        tool_name = getattr(tool, "__name__", None)
        if tool_name and tool_name in mocks:
            # Use the mock, but ensure it has the correct name and docstring
            # (ADK might use docstrings for tool definitions)
            mock = mocks[tool_name]
            mock.__name__ = tool_name
            mock.__doc__ = tool.__doc__  # Copy docstring from original
            new_tools.append(mock)
        else:
            new_tools.append(tool)

    return Agent(
        name="test_policy_agent",
        model="gemini-2.5-flash",
        description=agent_module.root_agent.description,
        instruction=agent_module.root_agent.instruction,
        tools=new_tools,
    )


@pytest.fixture
def runner() -> Runner:
    return Runner(
        app_name="test-conversation",
        agent=create_test_agent(),
        session_service=InMemorySessionService(),
        artifact_service=InMemoryArtifactService(),
    )


@pytest.mark.asyncio
async def test_conversational_policy_creation(runner: Runner) -> None:
    """
    Tests a multi-turn conversation where the user asks to create a policy
    from GCS, and the agent follows the correct steps (find -> generate -> save -> run).
    """
    user_id = "test-user"
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user_id
    )
    session_id = session.id

    # Turn 1: User Greeting / Intent
    # Expect agent to ask for source.
    response_text = await send_message(
        runner,
        user_id,
        session_id,
        "I want to check if table descriptions exist.",
    )
    # We can't strictly assert the exact text, but we can check if it mentions "GCS" or "Dataplex"
    # or if the tool was NOT called yet (since we haven't given source).
    # But the model might be eager and assume a source or call 'find' with unknown source.
    # Let's just print it for debugging if needed, or check flow.

    # Turn 2: User provides source
    response_text = await send_message(runner, user_id, session_id, "Use GCS.")

    # The agent SHOULD now try to find the policy. Our mock returns "not_found".
    # Then it should ask for the GCS URI (since it needs it to generate).

    # Turn 3: User provides URI
    response_text = await send_message(
        runner, user_id, session_id, "gs://my-bucket/metadata.jsonl"
    )

    # Now the agent SHOULD:
    # 1. Call generate_policy_code_from_gcs
    # 2. Call save_policy_to_memory
    # 3. Call run_policy_from_gcs
    # 4. Report results.

    assert (
        "Mock violation" in response_text
        or "violations found" in response_text.lower()
    ), (
        f"Agent response did not contain expected mock result. Got: {response_text}"
    )


async def send_message(
    runner: Runner, user_id: str, session_id: str, text: str
) -> str:
    """Helper to send a message and get the final text response."""
    input_content = types.UserContent(text)
    response_parts = []

    async for event in runner.run_async(
        user_id=user_id, session_id=session_id, new_message=input_content
    ):
        if event.content:
            for part in event.content.parts:
                if part.text:
                    response_parts.append(part.text)

    return "".join(response_parts)
