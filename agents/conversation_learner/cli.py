# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Non-interactive CLI for ConversationLearner.

This is a scriptable entrypoint alongside the interactive ``adk run .`` REPL and
the Agent Engine deployment (``deploy.py``). It supports two ways to drive the
agent:

* **Deterministic flags** (``--reasoning_engine_id`` / ``--conversation_id`` +
  a time window) call :func:`agent.generate_learnings` directly — no LLM in the
  loop, so it's fast and reproducible (good for cron/CI).
* **``--prompt``** routes a natural-language request through the ADK
  ``root_agent`` exactly once (the LLM extracts the parameters), mirroring
  ``adk run`` non-interactively.

Both paths fetch trajectories from Cloud Logging, run the per-conversation
LLM-as-judge, dedup, and write ``proposal.json`` (location controlled by
``--output``).

Usage::

    # From the agents/ directory:
    python -m conversation_learner --reasoning_engine_id <id> --days_ago 7
    # Or as a script from anywhere:
    python conversation_learner/cli.py --conversation_id <id> --include_ids
    python conversation_learner/cli.py --prompt "generate learnings for <re> in the past 7 days"
"""

import argparse
import asyncio
import os
import sys

_APP_NAME = "conversation_learner"
_USER_ID = "cli"

# Summary prefixes generate_learnings returns on failure (it catches errors and
# returns a message rather than raising). Used to set a non-zero exit code.
_ERROR_PREFIXES = (
    "API Error",
    "An unexpected error occurred",
    "Either conversation_id",
)


def build_parser() -> argparse.ArgumentParser:
    """Builds the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="conversation_learner",
        description=(
            "Analyze agent conversation trajectories and write enrichment "
            "proposals to proposal.json. Use deterministic flags, or --prompt "
            "for a natural-language request routed through the LLM."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  python -m conversation_learner "
            "--reasoning_engine_id projects/p/locations/l/reasoningEngines/123 "
            "--days_ago 7 --include_ids\n"
            "  python -m conversation_learner --conversation_id abc123\n"
            "  python -m conversation_learner "
            '--prompt "generate learnings for ...reasoningEngines/123 in the past 7 days"\n'
        ),
    )

    # Natural-language mode.
    parser.add_argument(
        "--prompt",
        help=(
            "Natural-language request routed through the ADK agent (the LLM "
            "extracts parameters). Mutually exclusive with the selector flags "
            "below."
        ),
    )

    # Deterministic selector flags.
    parser.add_argument("--conversation_id", help="A single conversation id to analyze.")
    parser.add_argument(
        "--reasoning_engine_id",
        help="Reasoning Engine id or full resource path to analyze.",
    )
    parser.add_argument(
        "--days_ago", type=int, help="Look-back window in days (with --reasoning_engine_id)."
    )
    parser.add_argument("--start_time", help="ISO 8601 start of an explicit time window.")
    parser.add_argument("--end_time", help="ISO 8601 end of an explicit time window.")
    parser.add_argument(
        "--include_ids",
        action="store_true",
        help="Attach a deterministic, run-stable id to each saved proposal.",
    )

    # Common config.
    parser.add_argument(
        "--project",
        help="Google Cloud project (default: $GOOGLE_CLOUD_PROJECT).",
    )
    parser.add_argument(
        "--location",
        help="Vertex AI location (sets $GOOGLE_CLOUD_LOCATION; default: leave unchanged).",
    )
    parser.add_argument(
        "--output",
        help=(
            "Where to write proposals (default: ./proposal.json). A directory is "
            "allowed; proposal.json is written inside it."
        ),
    )
    return parser


def _resolve_output(raw: str | None) -> str:
    """Resolves --output to a file path (writing into a directory if one is given)."""
    if not raw:
        return "proposal.json"
    if raw.endswith(os.sep) or os.path.isdir(raw):
        return os.path.join(raw, "proposal.json")
    return raw


def _ensure_package_importable() -> None:
    """Puts agents/ (the package parent) on sys.path so `conversation_learner` imports."""
    pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if pkg_parent not in sys.path:
        sys.path.insert(0, pkg_parent)


def _run_flags(args: argparse.Namespace) -> str:
    """Deterministic path: call generate_learnings() directly."""
    from conversation_learner import agent

    return asyncio.run(
        agent.generate_learnings(
            conversation_id=args.conversation_id,
            reasoning_engine_id=args.reasoning_engine_id,
            days_ago=args.days_ago,
            start_time=args.start_time,
            end_time=args.end_time,
            project_id=args.project,
            include_ids=args.include_ids,
        )
    )


async def _aprompt(prompt: str) -> str:
    """Drives the ADK root_agent once and returns its final text response."""
    from conversation_learner.agent import root_agent
    from google.adk.runners import InMemoryRunner
    from google.genai import types

    runner = InMemoryRunner(agent=root_agent, app_name=_APP_NAME)
    session = await runner.session_service.create_session(
        app_name=_APP_NAME, user_id=_USER_ID
    )
    final = ""
    async for event in runner.run_async(
        user_id=_USER_ID,
        session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part(text=prompt)]),
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final = "".join(part.text or "" for part in event.content.parts)
    return final


def _run_prompt(prompt: str) -> str:
    """Natural-language path: route the prompt through the LLM agent (one-shot)."""
    return asyncio.run(_aprompt(prompt))


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint. Returns a process exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)

    has_selector = (
        any([args.conversation_id, args.reasoning_engine_id, args.start_time, args.end_time])
        or args.days_ago is not None
        or args.include_ids
    )

    # --- Validate the selected mode before touching env or importing the agent.
    if args.prompt:
        if has_selector:
            parser.error(
                "--prompt cannot be combined with --conversation_id / "
                "--reasoning_engine_id / --days_ago / --start_time / --end_time / "
                "--include_ids (they are extracted from the prompt instead)."
            )
    elif not (
        args.conversation_id
        or (args.reasoning_engine_id and (args.days_ago is not None or args.start_time))
    ):
        parser.error(
            "provide --conversation_id, or --reasoning_engine_id with one of "
            "--days_ago / --start_time (or use --prompt)."
        )

    # --- Resolve project and set Vertex env BEFORE importing the agent: agent.py
    # reads GOOGLE_CLOUD_PROJECT at import time to build consumer_project /
    # GEMINI_MODEL, and the judge client uses them.
    project = args.project or os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project:
        parser.error("--project is required (pass --project or set GOOGLE_CLOUD_PROJECT).")
    args.project = project
    os.environ["GOOGLE_CLOUD_PROJECT"] = project
    if args.location:
        os.environ["GOOGLE_CLOUD_LOCATION"] = args.location
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "True")

    _ensure_package_importable()
    from conversation_learner import agent

    agent.set_default_output_path(_resolve_output(args.output))

    if args.prompt:
        summary = _run_prompt(args.prompt)
    else:
        summary = _run_flags(args)

    print(summary)
    return 1 if summary.startswith(_ERROR_PREFIXES) else 0


if __name__ == "__main__":
    sys.exit(main())
