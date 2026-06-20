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

"""ConversationLearner agent for analyzing conversational trajectories."""

import asyncio
import json
import os
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime, timedelta, timezone

from google.adk.agents.llm_agent import LlmAgent
from google.adk.models import google_llm
from google.api_core.exceptions import GoogleAPICallError, RetryError
from google.cloud import logging as cloud_logging
from pydantic import BaseModel, Field

# Add current directory to sys.path to ensure utils can be imported regardless of execution context
import sys
if os.path.dirname(os.path.abspath(__file__)) not in sys.path:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import get_consumer_project

consumer_project = get_consumer_project()


def _tolerant_json_array(raw: str) -> Tuple[List[Any], bool]:
    """Parses a JSON array, salvaging complete elements if it was truncated.

    Cloud Logging caps every label value at 64 KiB, so a large
    ``gen_ai.input.messages`` / ``gen_ai.output.messages`` value can be cut off
    mid-string, leaving invalid JSON. When a clean parse fails we recover as
    many complete top-level elements as possible from the prefix.

    Returns:
        (elements, truncated) where ``truncated`` is True if the value did not
        parse cleanly and best-effort salvage was attempted.
    """
    raw = (raw or "").strip()
    if not raw:
        return [], False
    try:
        data = json.loads(raw)
        return (data if isinstance(data, list) else [data]), False
    except json.JSONDecodeError:
        pass

    # Salvage path: decode complete array elements one at a time until we hit
    # the truncated tail.
    decoder = json.JSONDecoder()
    elements: List[Any] = []
    i, n = 0, len(raw)
    while i < n and raw[i] != "[":  # advance to the start of the array
        i += 1
    i += 1  # step past '['
    while i < n:
        while i < n and raw[i] in " \t\r\n,":  # skip separators between elements
            i += 1
        if i >= n or raw[i] == "]":
            break
        try:
            element, i = decoder.raw_decode(raw, i)
        except json.JSONDecodeError:
            break  # reached the truncated/incomplete tail
        elements.append(element)
    return elements, True


def _format_message(msg: Any) -> str:
    """Formats one parsed message object into a ``[ROLE]: content`` line."""
    if not isinstance(msg, dict):
        return f"[UNKNOWN]: {msg}"
    role = msg.get("role", "UNKNOWN")
    content_parts = []
    for part in msg.get("parts", []):
        if not isinstance(part, dict):
            continue
        if "content" in part:
            content_parts.append(f"{part['content']}\n")
        elif "arguments" in part:
            content_parts.append(f"Tool Call: {part.get('name', '')} {json.dumps(part['arguments'])}\n")
        elif "text" in part:
            content_parts.append(f"{part['text']}\n")
    content = "".join(content_parts)
    return f"[{role.upper()}]: {content.strip()}"


def _render_conversation(entries: List[Any], output: List[str]) -> None:
    """Merges every log entry of a single conversation into one transcript.

    Each inference log's ``gen_ai.input.messages`` accumulates the running
    history, so a later entry is normally a superset of earlier ones. But that
    same growth means the latest entry is the one most likely to exceed Cloud
    Logging's 64 KiB label limit and be truncated to invalid JSON. Rather than
    trust a single entry, we union the messages parsed from *all* entries
    (deduplicated, in chronological order) so smaller earlier entries backfill
    a truncated later one, and we salvage partial content from truncated labels.
    """
    if not entries:
        return
    entries = sorted(entries, key=lambda e: e.timestamp)

    seen = set()
    ordered_msgs: List[Any] = []
    truncated = False
    for entry in entries:
        labels = entry.to_api_repr().get("labels", {})
        for key in ("gen_ai.input.messages", "gen_ai.output.messages"):
            if key not in labels:
                continue
            parsed, was_truncated = _tolerant_json_array(labels[key])
            truncated = truncated or was_truncated
            for msg in parsed:
                msg_key = json.dumps(msg, sort_keys=True, default=str)
                if msg_key not in seen:
                    seen.add(msg_key)
                    ordered_msgs.append(msg)

    if not ordered_msgs:
        # No Reasoning Engine message labels anywhere; fall back to the raw
        # payload of the most recent entry.
        _parse_generic_payload(entries[-1].payload, output)
        return

    if truncated:
        output.append(
            "(note: one or more log labels exceeded Cloud Logging's 64 KiB limit "
            "and were truncated; transcript merged and salvaged across all entries.)"
        )
    for msg in ordered_msgs:
        output.append(_format_message(msg))
        output.append("-" * 20)


def _parse_generic_payload(payload: Any, output: List[str]) -> None:
    """Fallback payload parser if Reasoning Engine labels are absent."""
    role = "UNKNOWN"
    content_text = ""

    if isinstance(payload, dict):
        role = payload.get("role", role)
        if "message" in payload and isinstance(payload["message"], dict):
            msg_obj = payload["message"]
            if "user_message" in msg_obj:
                role = "USER"
                content_text = msg_obj["user_message"].get("text", "")
            elif "system_message" in msg_obj:
                role = "SYSTEM"
                content_text = msg_obj["system_message"].get("text", "")
        else:
            content_text = payload.get("text") or payload.get("message") or str(payload)
    elif isinstance(payload, str):
        content_text = payload
    else:
        content_text = str(payload)

    output.append(f"[{role}]: {content_text}")
    output.append("-" * 20)


def _conversation_filter(conversation_id: str) -> str:
    """Cloud Logging filter for a single conversation (across all time)."""
    return (
        f'resource.type="aiplatform.googleapis.com/ReasoningEngine" '
        f'AND labels."gen_ai.conversation.id"="{conversation_id}" '
        f'AND timestamp>="2023-01-01T00:00:00Z"'
    )


def _reasoning_engine_filter(re_id: str, start_time_str: str, end_time: Optional[str] = None) -> str:
    """Cloud Logging filter for a Reasoning Engine's trajectory logs.

    Restricted to entries carrying a non-empty ``gen_ai.conversation.id`` (the
    vast majority of ReasoningEngine logs have no conversation id and are not
    trajectories) within the given time window.
    """
    filter_str = (
        f'resource.type="aiplatform.googleapis.com/ReasoningEngine" '
        f'AND resource.labels.reasoning_engine_id="{re_id}" '
        f'AND labels."gen_ai.conversation.id"!="" '
        f'AND timestamp>="{start_time_str}"'
    )
    if end_time:
        filter_str += f' AND timestamp<="{end_time}"'
    return filter_str


def _group_by_conversation(entries: List[Any]) -> Dict[str, List[Any]]:
    """Groups log entries by ``gen_ai.conversation.id``, preserving input order."""
    grouped: Dict[str, List[Any]] = {}
    for entry in entries:
        labels = entry.to_api_repr().get("labels", {})
        c_id = labels.get("gen_ai.conversation.id")
        if c_id:
            grouped.setdefault(c_id, []).append(entry)
    return grouped


def _fetch_and_group(
    project_id: str,
    conversation_id: Optional[str] = None,
    reasoning_engine_id: Optional[str] = None,
    days_ago: Optional[int] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
) -> Tuple[List[Any], Dict[str, List[Any]]]:
    """Fetches matching trajectory log entries and groups them by conversation.

    Blocking (network I/O) — call via ``asyncio.to_thread`` from async code.
    Callers must validate that either ``conversation_id`` or (``reasoning_engine_id``
    plus a time window) is provided before calling.

    Returns:
        (all_entries, {conversation_id: [entries]}).
    """
    client = cloud_logging.Client(project=project_id)
    if conversation_id:
        filter_str = _conversation_filter(conversation_id)
    else:
        re_id = reasoning_engine_id.split("/")[-1]
        start_time_str = start_time or (
            datetime.now(timezone.utc) - timedelta(days=days_ago)
        ).isoformat()
        filter_str = _reasoning_engine_filter(re_id, start_time_str, end_time)
    entries = list(client.list_entries(filter_=filter_str, order_by=cloud_logging.DESCENDING, page_size=1000))
    return entries, _group_by_conversation(entries)


def get_agent_trajectories(
    conversation_id: Optional[str] = None,
    reasoning_engine_id: Optional[str] = None,
    days_ago: Optional[int] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    project_id: str = consumer_project
) -> str:
    """
    Retrieves the conversation trajectories from Google Cloud Logging.

    Args:
        conversation_id: The ID of the conversation to retrieve.
        reasoning_engine_id: The ID of the Reasoning Engine to retrieve logs for.
        days_ago: Number of days to look back when filtering by reasoning_engine_id.
        start_time: Start time of the time window to filter logs (ISO 8601 string).
        end_time: End time of the time window to filter logs (ISO 8601 string).
        project_id: Google Cloud Project ID.

    Returns:
        A string representation of the agent's conversational trajectories.
    """
    output = []

    try:
        client = cloud_logging.Client(project=project_id)
        
        if conversation_id:
            output.append(f"--- Fetching Conversation: {conversation_id} ---")
            filter_str = _conversation_filter(conversation_id)
            entries = list(client.list_entries(filter_=filter_str, order_by=cloud_logging.DESCENDING, page_size=1000))

            output.append("--- Chat History ---")

            if not entries:
                output.append("No messages found in this conversation via Cloud Logging.")
                return "\n".join(output)

            _render_conversation(entries, output)

        elif reasoning_engine_id and (days_ago is not None or start_time is not None):
            if start_time:
                start_time_str = start_time
                time_range_msg = f"from {start_time_str}"
                if end_time:
                    time_range_msg += f" to {end_time}"
            else:
                start_time_dt = datetime.now(timezone.utc) - timedelta(days=days_ago)
                start_time_str = start_time_dt.isoformat()
                time_range_msg = f"for past {days_ago} days"

            output.append(f"--- Fetching Reasoning Engine: {reasoning_engine_id} {time_range_msg} ---")
            
            re_id = reasoning_engine_id.split("/")[-1]
            filter_str = _reasoning_engine_filter(re_id, start_time_str, end_time)

            entries = list(client.list_entries(filter_=filter_str, order_by=cloud_logging.DESCENDING, page_size=1000))

            if not entries:
                output.append("No messages found for this Reasoning Engine in the specified time range.")
                return "\n".join(output)

            conv_entries = _group_by_conversation(entries)

            output.append(f"Total log entries retrieved: {len(entries)}. Unique conversations: {len(conv_entries)}.")
            output.append(f"Conversation IDs: {', '.join(conv_entries.keys())}")

            for c_id, c_entries in conv_entries.items():
                output.append(f"\n--- Conversation: {c_id} ---")
                _render_conversation(c_entries, output)
                    
        else:
            output.append("Either conversation_id or (reasoning_engine_id and (days_ago or start_time)) must be provided.")

    except (GoogleAPICallError, RetryError) as e:
        output.append(f"API Error: {e}")
    except Exception as e:
        import traceback
        output.append(f"An unexpected error occurred: {e}\n{traceback.format_exc()}")

    return "\n".join(output)


# ==============================================================================
# DATA MODELS FOR CONVERSATIONLEARNER
# ==============================================================================

class DetectionSignal(str, Enum):
    DIRECT_USER_CORRECTION = "DIRECT_USER_CORRECTION"
    IMPLICIT_USER_FRICTION = "IMPLICIT_USER_FRICTION"
    AGENT_SELF_REFLECTION = "AGENT_SELF_REFLECTION"
    USER_SATISFACTION = "USER_SATISFACTION"


class GapType(str, Enum):
    LEXICAL_SYNONYM_GAP = "LEXICAL_SYNONYM_GAP"
    BUSINESS_LOGIC_GAP = "BUSINESS_LOGIC_GAP"
    STRUCTURAL_ROUTING_GAP = "STRUCTURAL_ROUTING_GAP"
    UNCATALOGED_ASSET_DISCOVERY = "UNCATALOGED_ASSET_DISCOVERY"
    VALIDATED_CONTEXT = "VALIDATED_CONTEXT"


class EnrichmentAction(str, Enum):
    UPDATE_OVERVIEW_ASPECT = "UPDATE_OVERVIEW_ASPECT"
    FLAG_FOR_CATALOGING = "FLAG_FOR_CATALOGING"
    BOOST_CONFIDENCE = "BOOST_CONFIDENCE"


class AssetType(str, Enum):
    TABLE = "TABLE"
    COLUMN = "COLUMN"
    GLOSSARY_TERM = "GLOSSARY_TERM"
    UNCATALOGED_ASSET = "UNCATALOGED_ASSET"


class Classification(BaseModel):
    detection_signal: DetectionSignal = Field(description="The behavioral evidence found in the trajectory.")
    gap_type: GapType = Field(description="The actual metadata missing from the Knowledge Catalog.")


class TargetAsset(BaseModel):
    type: AssetType
    name: str = Field(description="The specific Knowledge Catalog asset name, e.g., 'dataset.table_a.gross_margin'")


class ProposedEnrichment(BaseModel):
    action: EnrichmentAction = Field(description="The API action the Metadata Enrichment Agent should take.")
    value: str = Field(description="The precise synonym string, SQL formula, or text description to apply.")


class Evidence(BaseModel):
    reasoning: str = Field(description="Explain exactly how the detection_signal proves the gap_type.")
    trajectory_quote: str = Field(description="Quote the exact user phrase, SQL diff, or tool error that validates this learning.")


class EvalCandidate(BaseModel):
    is_valid_candidate: bool = Field(description="True if the trajectory ended with a successful query execution.")
    user_query_intent: Optional[str] = Field(None, description="The final, clean natural language user question.")
    golden_sql: Optional[str] = Field(None, description="The correct, successful SQL that satisfied the intent.")


class ContextEnrichmentProposal(BaseModel):
    classification: Classification
    target_asset: TargetAsset
    current_context_flaw: Optional[str] = Field(None, description="What the agent incorrectly assumed or what is missing. Null if perfectly valid.")
    proposed_enrichment: ProposedEnrichment
    evidence: Evidence
    confidence_grade: float = Field(ge=0.0, le=1.0, description="Float between 0.0 and 1.0 based on the clarity of the signal.")
    eval_candidate: EvalCandidate
    enrichment_agent_instruction: str = Field(description="A clear, actionable natural language instruction for the Metadata Enrichment Agent containing all details needed to perform the enrichment (e.g. target asset, action, and new value). DO NOT include the background reasoning, user story, or evidence.")


class TrajectoryAnalysisResult(BaseModel):
    proposals: List[ContextEnrichmentProposal] = Field(
        description="A list of proposed enrichments found in the trajectory. Return an empty list [] if no gap or signal is detected."
    )

def _redact_sensitive(text: str) -> str:
    """Redacts common PII/sensitive patterns from a string."""
    import re
    patterns = [
        (r'\b\d{3}-\d{2}-\d{4}\b', '[SSN REDACTED]'),
        (r'\b(?:\d[ -]?){13,16}\b', '[CARD REDACTED]'),
        (r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', '[EMAIL REDACTED]'),
        (r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b', '[PHONE REDACTED]'),
        (r'\b(?:password|passwd|secret|api[_-]?key|token|bearer|credential)[\s:=]+\S+', '[CREDENTIAL REDACTED]', re.IGNORECASE),
    ]
    for pattern, replacement, *flags in patterns:
        flag = flags[0] if flags else 0
        text = re.sub(pattern, replacement, text, flags=flag)
    return text


def _redact_obj(obj):
    """Recursively redacts sensitive values in a parsed JSON object."""
    if isinstance(obj, str):
        return _redact_sensitive(obj)
    if isinstance(obj, dict):
        return {k: _redact_obj(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_redact_obj(v) for v in obj]
    return obj


def save_trajectory_analysis_result(result_json: str) -> str:
    """
    Saves the final trajectory analysis result to a local file.
    Must be called to conclude the analysis.

    Args:
        result_json: JSON string with the following structure:
            {
              "proposals": [
                {
                  "classification": {
                    "detection_signal": "<DIRECT_USER_CORRECTION|IMPLICIT_USER_FRICTION|AGENT_SELF_REFLECTION|USER_SATISFACTION>",
                    "gap_type": "<LEXICAL_SYNONYM_GAP|BUSINESS_LOGIC_GAP|STRUCTURAL_ROUTING_GAP|UNCATALOGED_ASSET_DISCOVERY|VALIDATED_CONTEXT>"
                  },
                  "target_asset": {
                    "type": "<TABLE|COLUMN|GLOSSARY_TERM|UNCATALOGED_ASSET>",
                    "name": "<asset path, e.g. dataset.table.column>"
                  },
                  "current_context_flaw": "<string or null>",
                  "proposed_enrichment": {
                    "action": "<UPDATE_OVERVIEW_ASPECT|FLAG_FOR_CATALOGING|BOOST_CONFIDENCE>",
                    "value": "<the exact synonym, formula, or description to apply>"
                  },
                  "evidence": {
                    "reasoning": "<how the detection_signal proves the gap_type>",
                    "trajectory_quote": "<exact quote from the trajectory>"
                  },
                  "confidence_grade": <0.0 to 1.0>,
                  "eval_candidate": {
                    "is_valid_candidate": <true|false>,
                    "user_query_intent": "<natural language question or null>",
                    "golden_sql": "<successful SQL or null>"
                  },
                  "enrichment_agent_instruction": "<direct imperative instruction for the Enrichment Agent>"
                }
              ]
            }
    """
    import re
    filename = "proposal.json"
    try:
        parsed = json.loads(result_json)
    except json.JSONDecodeError:
        # Fix invalid backslash escapes that LLMs sometimes produce inside SQL strings
        fixed = re.sub(r'\\(?!["\\/bfnrtu])', r'\\\\', result_json)
        parsed = json.loads(fixed)
    if isinstance(parsed, list):
        parsed = {"proposals": parsed}
    parsed = _redact_obj(parsed)
    with open(filename, "w") as f:
        json.dump(parsed, f, indent=2)
    return f"Successfully saved proposal to {filename}"

# Path to the skill file relative to the agent.py location
SKILL_FILE_PATH = os.path.join(os.path.dirname(__file__), "SKILL.md")


def load_instruction() -> str:
    """Loads the agent instruction from the SKILL.md file."""
    try:
        with open(SKILL_FILE_PATH, "r") as f:
            content = f.read()
    except FileNotFoundError:
        content = (
            "You are ConversationLearner. Analyze conversational trajectories to identify metadata gaps."
        )
    return content


GEMINI_MODEL = f"projects/{consumer_project}/locations/global/publishers/google/models/gemini-2.5-pro"


# ==============================================================================
# PER-CONVERSATION LLM-AS-JUDGE ORCHESTRATION
# ==============================================================================
# Each conversation is judged by its own direct generate_content call (bypassing
# ADK), fanned out in parallel, then proposals are deduplicated across
# conversations. This bounds each judge's context (vs. one giant pass over every
# conversation), scales, and isolates per-conversation failures. Mirrors the
# direct-call + asyncio.gather + retry pattern in agents/enrichment/src/common.py.

# Transient Vertex / model-serving errors that are safe to retry. Matched
# case-insensitively against the error text (the SDK surfaces these as
# ClientError / ServerError with the status in the message).
_RETRYABLE_MARKERS = (
    "429", "resource_exhausted", "rate limit", "quota exceeded",
    "503", "unavailable", "500", "internal error",
    "deadline", "timed out", "timeout", "connection reset",
)

_JUDGE_CONCURRENCY = 8

# The judge analyzes ONE conversation and returns structured proposals directly
# (no tool calls), so it gets a focused output directive on top of the SKILL.md
# rubric.
JUDGE_RUBRIC = load_instruction()

_JUDGE_OUTPUT_DIRECTIVE = (
    "\n\nYou are given the trajectory of a SINGLE conversation below. Analyze "
    "only this conversation and output a JSON object of the form "
    '{"proposals": [...]} conforming to the schema. Return {"proposals": []} '
    "when nothing qualifies. Do not call any tools."
)

# The outer ADK agent is just a natural-language front-end: it extracts the
# parameters from the user's request and delegates everything to the
# generate_learnings tool (which fetches, judges per conversation, dedupes, and
# saves).
ORCHESTRATOR_INSTRUCTION = (
    "You are ConversationLearner. When the user asks you to generate learnings, "
    "extract the parameters from their request and call the `generate_learnings` "
    "tool EXACTLY ONCE:\n"
    "- If given a conversation id or a Cloud Logging URL, pass `conversation_id` "
    "(extract the `gen_ai.conversation.id` value from a URL).\n"
    "- If given a Reasoning Engine id (or full resource path) and a time filter, "
    "pass `reasoning_engine_id` plus either `days_ago` or `start_time`/`end_time` "
    "(ISO 8601).\n"
    "Then report the tool's returned summary verbatim to the user. Do not call "
    "the tool more than once and do not call any other tools."
)


def _is_retryable(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(m in msg for m in _RETRYABLE_MARKERS)


async def _with_retry(fn, *, what="LLM call", attempts=5, base_delay=2.0, max_delay=30.0):
    """Runs async ``fn()`` with exponential backoff on transient model errors.

    Non-retryable errors raise immediately; if all attempts are exhausted the
    last error propagates. Ported from agents/enrichment/src/common.py (kept
    self-contained — this package is deployed alone via extra_packages=['.']).
    """
    import random
    for i in range(attempts):
        try:
            return await fn()
        except Exception as e:  # pylint: disable=broad-except
            if i == attempts - 1 or not _is_retryable(e):
                raise
            delay = min(max_delay, base_delay * (2 ** i)) + random.uniform(0, 1.5)
            print(
                f"[retry] {what}: {type(e).__name__}: {str(e)[:140]} — "
                f"attempt {i + 1}/{attempts}, backing off {delay:.1f}s",
                flush=True,
            )
            await asyncio.sleep(delay)


def _parse_analysis_text(text: str) -> List[Dict[str, Any]]:
    """Parses judge output text into proposal dicts.

    Tolerates ``` code fences and the invalid backslash escapes LLMs emit inside
    SQL strings (same repair as save_trajectory_analysis_result).
    """
    import re
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        m = re.match(r"^```(?:json)?\s*\n(.*)\n```$", cleaned, re.S)
        if m:
            cleaned = m.group(1).strip()
    if not cleaned:
        return []
    try:
        result = TrajectoryAnalysisResult.model_validate_json(cleaned)
    except Exception:
        fixed = re.sub(r'\\(?!["\\/bfnrtu])', r'\\\\', cleaned)
        result = TrajectoryAnalysisResult.model_validate_json(fixed)
    return [p.model_dump(mode="json") for p in result.proposals]


def _judge_conversation_sync(conversation_id: str, transcript: str) -> List[Dict[str, Any]]:
    """Runs the LLM-as-judge on ONE conversation. Blocking — run via to_thread.

    Returns a list of proposal dicts (empty if nothing qualifies, or the response
    was blocked / could not be parsed). Builds a fresh genai client per call:
    the SDK's pyOpenSSL transport mutates an SSL context per request and is not
    safe to share across the to_thread worker pool (see enrichment/common.py).
    """
    from google.auth import default
    from google.genai import Client, types

    creds, _ = default()
    client = Client(
        vertexai=True,
        credentials=creds,
        project=consumer_project,
        location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
    )
    config = types.GenerateContentConfig(
        system_instruction=JUDGE_RUBRIC + _JUDGE_OUTPUT_DIRECTIVE,
        response_mime_type="application/json",
        response_schema=TrajectoryAnalysisResult,
        temperature=0,
    )
    prompt = f"Conversation ID: {conversation_id}\n\nTrajectory:\n{transcript}"
    resp = client.models.generate_content(model=GEMINI_MODEL, contents=prompt, config=config)

    parsed = getattr(resp, "parsed", None)
    if isinstance(parsed, TrajectoryAnalysisResult):
        return [p.model_dump(mode="json") for p in parsed.proposals]

    # resp.parsed is None on truncation / safety block / malformed JSON — fall
    # back to repairing and parsing the raw text.
    try:
        return _parse_analysis_text(getattr(resp, "text", "") or "")
    except Exception as e:  # pylint: disable=broad-except
        finish = None
        try:
            finish = resp.candidates[0].finish_reason
        except Exception:  # pylint: disable=broad-except
            pass
        print(
            f"[judge] {conversation_id}: could not parse response "
            f"(finish_reason={finish}): {e}",
            flush=True,
        )
        return []


def _aggregate_proposals(proposals: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Deduplicates proposals across conversations (lightweight aggregation pass).

    Proposals targeting the same asset (type + normalized name) with the same
    gap_type are treated as the same learning; the highest-confidence instance is
    kept. A blank asset name (e.g. uncataloged-asset discoveries) falls back to a
    hash of the enrichment instruction so genuinely distinct finds are not merged.
    """
    import hashlib
    by_key: Dict[tuple, Dict[str, Any]] = {}
    for p in proposals:
        asset = p.get("target_asset") or {}
        atype = asset.get("type", "")
        name = (asset.get("name") or "").strip().lower()
        gap = (p.get("classification") or {}).get("gap_type", "")
        if name:
            key = (atype, name, gap)
        else:
            instr = p.get("enrichment_agent_instruction") or json.dumps(
                p.get("proposed_enrichment", ""), sort_keys=True
            )
            key = (atype, gap, hashlib.sha1(instr.encode()).hexdigest()[:12])
        existing = by_key.get(key)
        if existing is None or (p.get("confidence_grade") or 0) > (existing.get("confidence_grade") or 0):
            by_key[key] = p
    return list(by_key.values())


async def generate_learnings(
    conversation_id: Optional[str] = None,
    reasoning_engine_id: Optional[str] = None,
    days_ago: Optional[int] = None,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    project_id: str = consumer_project,
) -> str:
    """Analyzes agent conversation trajectories and saves enrichment proposals.

    Fetches trajectories from Cloud Logging, runs the LLM-as-judge independently
    on EACH conversation in parallel, deduplicates the proposals across
    conversations, saves them to proposal.json, and returns a summary.

    Args:
        conversation_id: A single conversation id to analyze.
        reasoning_engine_id: Reasoning Engine id (or full resource path) to analyze.
        days_ago: Look-back window in days (use with reasoning_engine_id).
        start_time: ISO 8601 start of an explicit time window.
        end_time: ISO 8601 end of an explicit time window.
        project_id: Google Cloud Project ID.

    Returns:
        A human-readable summary of what was analyzed and saved.
    """
    if not conversation_id and not (
        reasoning_engine_id and (days_ago is not None or start_time is not None)
    ):
        return "Either conversation_id or (reasoning_engine_id and (days_ago or start_time)) must be provided."

    try:
        entries, grouped = await asyncio.to_thread(
            _fetch_and_group, project_id, conversation_id, reasoning_engine_id,
            days_ago, start_time, end_time,
        )
    except (GoogleAPICallError, RetryError) as e:
        return f"API Error: {e}"
    except Exception as e:  # pylint: disable=broad-except
        return f"An unexpected error occurred while fetching trajectories: {e}"

    if not grouped:
        return (
            "Total log entries retrieved: 0. Unique conversations: 0.\n"
            "No conversations with trajectories were found for the given parameters."
        )

    # Render each conversation into its own transcript.
    transcripts: Dict[str, str] = {}
    for c_id, c_entries in grouped.items():
        lines: List[str] = []
        _render_conversation(c_entries, lines)
        transcripts[c_id] = "\n".join(lines)

    # Fan out one judge call per conversation, concurrency-capped and retried
    # independently so a single failure yields [] rather than aborting the batch.
    sem = asyncio.Semaphore(_JUDGE_CONCURRENCY)

    async def _judge(c_id: str, transcript: str) -> List[Dict[str, Any]]:
        async with sem:
            try:
                return await _with_retry(
                    lambda: asyncio.to_thread(_judge_conversation_sync, c_id, transcript),
                    what=f"judge[{c_id}]",
                )
            except Exception as e:  # pylint: disable=broad-except
                print(f"[judge] {c_id}: failed after retries: {e}", flush=True)
                return []

    results = await asyncio.gather(*[_judge(c, t) for c, t in transcripts.items()])
    raw_proposals = [p for sub in results for p in sub]
    deduped = _aggregate_proposals(raw_proposals)

    save_trajectory_analysis_result(json.dumps({"proposals": deduped}))

    return (
        f"Total log entries retrieved: {len(entries)}. Unique conversations: {len(grouped)}.\n"
        f"Conversation IDs: {', '.join(grouped.keys())}\n"
        f"Analyzed each conversation independently; saved {len(deduped)} "
        f"deduplicated proposal(s) (from {len(raw_proposals)} raw) to proposal.json."
    )


conversation_learner = LlmAgent(
    model=google_llm.Gemini(model=GEMINI_MODEL),
    name='conversation_learner',
    description='Acts as an LLM-as-a-judge over conversational trajectories to detect friction and hallucination.',
    instruction=ORCHESTRATOR_INSTRUCTION,
    tools=[generate_learnings],
)

# ADK requires a variable named `root_agent` to serve as the entry point
root_agent = conversation_learner


