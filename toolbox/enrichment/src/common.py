"""Helpers shared by the doc and table enrichment modes."""

import json
import os
import re
import uuid

from google.genai import types


async def run_text(runner, prompt: str, usage_acc: dict | None = None) -> str:
    """Runs an InMemoryRunner once and returns the concatenated text output.

    Accumulates token usage into usage_acc when provided.
    """
    user_id = str(uuid.uuid4())
    session = await runner.session_service.create_session(app_name=runner.app_name, user_id=user_id)
    out = ""
    async for event in runner.run_async(
        user_id=user_id, session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part.from_text(text=prompt)]),
    ):
        usage = getattr(event, "usage_metadata", None)
        if usage and usage_acc is not None:
            usage_acc["input"] += getattr(usage, "prompt_token_count", 0) or 0
            usage_acc["output"] += getattr(usage, "candidates_token_count", 0) or 0
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.text:
                    out += part.text
    return out


def clean_overview_body(text: str) -> str:
    """Strip stray code fences / YAML frontmatter the model may have added, so the
    sidecar body is pure Markdown (table mode)."""
    t = (text or "").strip()
    # Strip an outer ```...``` fence ONLY if the model wrongly wrapped the whole
    # body in one. Greedy so inner ```sql blocks (Sample SQL) are preserved.
    if t.startswith("```"):
        m = re.match(r"^```[a-zA-Z]*\s*\n(.*)\n```$", t, re.S)
        if m:
            t = m.group(1).strip()
    # Strip a leading YAML frontmatter block if present (we add our own).
    if t.startswith("---"):
        m = re.match(r"^---\s*\n.*?\n---\s*\n(.*)$", t, re.S)
        if m:
            t = m.group(1).strip()
    return t


def parse_mdcode_blocks(text: str, output_dir: str) -> list[str]:
    """Parse fenced code blocks preceded by a backticked relative path and write
    them under output_dir. Used by doc mode where the LLM emits the mdcode files."""
    written = []
    if not output_dir:
        return written
    blocks = re.split(r'```(yaml|markdown|json|md)', text)
    for i in range(1, len(blocks), 2):
        block_content = blocks[i + 1].split('```')[0].strip()
        preceding_text = blocks[i - 1].strip().split('\n')[-1].strip()
        filename = None
        if preceding_text.startswith('`') and preceding_text.endswith('`'):
            filename = preceding_text.replace('`', '').replace("'", '').replace('"', '').strip()
        if not filename:
            continue
        full_path = os.path.join(output_dir, filename)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w") as f:
            f.write(block_content + "\n")
        written.append(filename)
        print(f"[+] Saved {filename} to {full_path}")
    return written


def write_trajectory(output_dir: str, agent_type: str, user_input: str,
                     tool_uses: list, tool_responses: list, final_text: str,
                     usage_acc: dict) -> None:
    """Persist trajectory.json capturing the agent's run (same shape for both modes).

    Written next to the generated mdcode as a record of what the agent read and
    produced; consumed by external evaluation/tooling that reads it by path.
    """
    if not output_dir:
        return
    os.makedirs(output_dir, exist_ok=True)
    trajectory = {
        "agent_type": agent_type,
        "user_input": user_input,
        "tool_uses": tool_uses,
        "tool_responses": tool_responses,
        "final_text": final_text,
        "token_usage": {"input": usage_acc["input"], "output": usage_acc["output"]},
    }
    traj_path = os.path.join(output_dir, "trajectory.json")
    with open(traj_path, "w") as f:
        json.dump(trajectory, f, indent=2, default=str)
    print(f"\n[+] Saved trajectory to {traj_path}")
