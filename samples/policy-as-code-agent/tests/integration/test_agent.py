"""Tests that the agent handles simple queries."""

import pytest
from google.adk.artifacts import InMemoryArtifactService
from google.adk.events.event import Event
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from policy_as_code_agent import agent


@pytest.fixture
def runner() -> Runner:
    return Runner(
        app_name="test",
        agent=agent.root_agent,
        session_service=InMemorySessionService(),
        artifact_service=InMemoryArtifactService(),
    )


@pytest.mark.asyncio
async def test_agent_responds_to_greeting(runner: Runner) -> None:
    """Checks if the agent responds successfully to a greeting."""

    question = "hi"

    events = await invoke(question=question, runner=runner)
    assert events, "Expected at least one event"

    content = events[-1].content
    assert content, "Expected at least one content"

    text = "\n\n".join(part.text for part in content.parts or [] if part.text)
    assert text


async def invoke(question: str, runner: Runner) -> list[Event]:
    """Invoke agent and return the resulting sequence of events."""

    # prepare user input
    user = "test-user"
    input_content = types.UserContent(question)

    # create session
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user
    )

    # run agent
    event_aiter = runner.run_async(
        user_id=user, session_id=session.id, new_message=input_content
    )
    events = [event async for event in event_aiter]

    return events
