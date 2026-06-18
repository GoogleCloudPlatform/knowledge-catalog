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

import json
import os
from enum import Enum
from typing import Any, Dict, List, Optional
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


def _parse_reasoning_engine_labels(labels: Dict[str, str], output: List[str]) -> bool:
    """Parses Reasoning Engine labels into the output list."""
    if "gen_ai.input.messages" not in labels and "gen_ai.output.messages" not in labels:
        return False

    inp_str = labels.get("gen_ai.input.messages", "[]")
    out_str = labels.get("gen_ai.output.messages", "[]")

    messages = []
    try:
        messages.extend(json.loads(inp_str))
        messages.extend(json.loads(out_str))

        chunks = []
        for msg in messages:
            role = msg.get("role", "UNKNOWN")
            content_parts = []
            for part in msg.get("parts", []):
                if "content" in part:
                    content_parts.append(part["content"] + "\n")
                elif "arguments" in part:
                    content_parts.append(f"Tool Call: {part.get('name', '')} {json.dumps(part['arguments'])}\n")
                elif "text" in part:
                    content_parts.append(part["text"] + "\n")
            content = "".join(content_parts)
            chunks.append(f"[{role.upper()}]: {content.strip()}")

        for chunk in chunks:
            output.append(chunk)
            output.append("-" * 20)
    except json.JSONDecodeError as e:
        output.append(f"Error parsing JSON in ReasoningEngine message labels: {e}")
    except Exception as e:
        import traceback
        output.append(f"Error parsing ReasoningEngine message labels: {e}\n{traceback.format_exc()}")

    return True


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
            filter_str = (
                f'resource.type="aiplatform.googleapis.com/ReasoningEngine" '
                f'AND labels."gen_ai.conversation.id"="{conversation_id}" '
                f'AND timestamp>="2023-01-01T00:00:00Z"'
            )
            entries = list(client.list_entries(filter_=filter_str, order_by=cloud_logging.DESCENDING, max_results=10))

            output.append("--- Chat History ---")

            if not entries:
                output.append("No messages found in this conversation via Cloud Logging.")
                return "\n".join(output)

            last_entry = entries[0]
            repr_dict = last_entry.to_api_repr()
            labels = repr_dict.get("labels", {})

            if not _parse_reasoning_engine_labels(labels, output):
                _parse_generic_payload(last_entry.payload, output)

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
            filter_str = (
                f'resource.type="aiplatform.googleapis.com/ReasoningEngine" '
                f'AND resource.labels.reasoning_engine_id="{re_id}" '
                f'AND timestamp>="{start_time_str}"'
            )
            if end_time:
                filter_str += f' AND timestamp<="{end_time}"'
            
            entries = list(client.list_entries(filter_=filter_str, order_by=cloud_logging.DESCENDING))
            
            if not entries:
                output.append("No messages found for this Reasoning Engine in the specified time range.")
                return "\n".join(output)
                
            conv_entries = {}
            for entry in entries:
                repr_dict = entry.to_api_repr()
                labels = repr_dict.get("labels", {})
                c_id = labels.get("gen_ai.conversation.id")
                if c_id and c_id not in conv_entries:
                    conv_entries[c_id] = entry

            output.append(f"Total log entries retrieved: {len(entries)}. Unique conversations: {len(conv_entries)}.")
            output.append(f"Conversation IDs: {', '.join(conv_entries.keys())}")

            for c_id, entry in conv_entries.items():
                output.append(f"\n--- Conversation: {c_id} ---")
                repr_dict = entry.to_api_repr()
                labels = repr_dict.get("labels", {})
                if not _parse_reasoning_engine_labels(labels, output):
                    _parse_generic_payload(entry.payload, output)
                    
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

conversation_learner = LlmAgent(
    model=google_llm.Gemini(model=GEMINI_MODEL),
    name='conversation_learner',
    description='Acts as an LLM-as-a-judge over conversational trajectories to detect friction and hallucination.',
    instruction=load_instruction(),
    tools=[get_agent_trajectories, save_trajectory_analysis_result]
)

# ADK requires a variable named `root_agent` to serve as the entry point
root_agent = conversation_learner


