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

"""Unit tests for the ConversationLearner agent."""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Required before importing agent — get_consumer_project() reads this at module level.
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")

# Add agents/ to sys.path so `conversation_learner` is importable as a package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from conversation_learner.agent import (  # noqa: E402
    _parse_generic_payload,
    _parse_reasoning_engine_labels,
    _redact_obj,
    _redact_sensitive,
    get_agent_trajectories,
    save_trajectory_analysis_result,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_log_entry(conversation_id=None, gen_ai_labels=False, payload="log line"):
    """Build a mock Cloud Logging entry."""
    entry = MagicMock()
    labels = {}
    if conversation_id:
        labels["gen_ai.conversation.id"] = conversation_id
    if gen_ai_labels:
        labels["gen_ai.input.messages"] = json.dumps(
            [{"role": "user", "parts": [{"text": "what is the total cost?"}]}]
        )
        labels["gen_ai.output.messages"] = json.dumps(
            [{"role": "assistant", "parts": [{"text": "The total cost is $500."}]}]
        )
    entry.to_api_repr.return_value = {"labels": labels}
    entry.payload = payload
    return entry


def _minimal_proposal(**overrides):
    """Return a minimal valid proposal dict."""
    base = {
        "classification": {
            "detection_signal": "DIRECT_USER_CORRECTION",
            "gap_type": "BUSINESS_LOGIC_GAP",
        },
        "target_asset": {"type": "COLUMN", "name": "proj.dataset.table.cost"},
        "current_context_flaw": "missing unit",
        "proposed_enrichment": {"action": "UPDATE_OVERVIEW_ASPECT", "value": "unit is USD"},
        "evidence": {
            "reasoning": "user corrected the agent",
            "trajectory_quote": "the cost unit is dollars",
        },
        "confidence_grade": 0.9,
        "eval_candidate": {
            "is_valid_candidate": True,
            "user_query_intent": "get total cost",
            "golden_sql": "SELECT sum(cost) FROM t",
        },
        "enrichment_agent_instruction": "Update cost column description to say unit is USD.",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# _redact_sensitive
# ---------------------------------------------------------------------------

class TestRedactSensitive(unittest.TestCase):

    def test_ssn_redacted(self):
        self.assertIn("[SSN REDACTED]", _redact_sensitive("SSN: 123-45-6789"))
        self.assertNotIn("123-45-6789", _redact_sensitive("SSN: 123-45-6789"))

    def test_email_redacted(self):
        result = _redact_sensitive("contact user@example.com for help")
        self.assertIn("[EMAIL REDACTED]", result)
        self.assertNotIn("user@example.com", result)

    def test_phone_us_format_redacted(self):
        result = _redact_sensitive("call 555-123-4567 now")
        self.assertIn("[PHONE REDACTED]", result)
        self.assertNotIn("555-123-4567", result)

    def test_credential_password_redacted(self):
        result = _redact_sensitive("password=supersecret")
        self.assertIn("[CREDENTIAL REDACTED]", result)
        self.assertNotIn("supersecret", result)

    def test_credential_api_key_redacted(self):
        result = _redact_sensitive("api_key=abc123xyz")
        self.assertIn("[CREDENTIAL REDACTED]", result)

    def test_credential_token_redacted(self):
        result = _redact_sensitive("token: eyJhbGciOiJIUzI1NiJ9")
        self.assertIn("[CREDENTIAL REDACTED]", result)

    def test_clean_text_unchanged(self):
        text = "The cost column represents billing in thousands of dollars."
        self.assertEqual(_redact_sensitive(text), text)

    def test_multiple_patterns_in_one_string(self):
        text = "user@test.com has SSN 123-45-6789"
        result = _redact_sensitive(text)
        self.assertIn("[EMAIL REDACTED]", result)
        self.assertIn("[SSN REDACTED]", result)
        self.assertNotIn("user@test.com", result)
        self.assertNotIn("123-45-6789", result)

    def test_empty_string_unchanged(self):
        self.assertEqual(_redact_sensitive(""), "")


# ---------------------------------------------------------------------------
# _redact_obj
# ---------------------------------------------------------------------------

class TestRedactObj(unittest.TestCase):

    def test_string_redacted(self):
        self.assertIn("[SSN REDACTED]", _redact_obj("SSN: 123-45-6789"))

    def test_dict_values_redacted(self):
        obj = {"trajectory_quote": "email: user@test.com", "label": "clean text"}
        result = _redact_obj(obj)
        self.assertIn("[EMAIL REDACTED]", result["trajectory_quote"])
        self.assertEqual(result["label"], "clean text")

    def test_dict_keys_preserved(self):
        obj = {"email_field": "user@test.com"}
        result = _redact_obj(obj)
        self.assertIn("email_field", result)

    def test_list_items_redacted(self):
        result = _redact_obj(["123-45-6789", "clean text"])
        self.assertEqual(result[0], "[SSN REDACTED]")
        self.assertEqual(result[1], "clean text")

    def test_nested_structure_fully_redacted(self):
        obj = {
            "proposals": [
                {"evidence": {"trajectory_quote": "SSN: 123-45-6789"}}
            ]
        }
        result = _redact_obj(obj)
        quote = result["proposals"][0]["evidence"]["trajectory_quote"]
        self.assertIn("[SSN REDACTED]", quote)
        self.assertNotIn("123-45-6789", quote)

    def test_non_string_scalars_passed_through(self):
        obj = {"confidence_grade": 0.95, "is_valid": True, "count": 3}
        self.assertEqual(_redact_obj(obj), obj)

    def test_none_passed_through(self):
        self.assertIsNone(_redact_obj(None))


# ---------------------------------------------------------------------------
# save_trajectory_analysis_result
# ---------------------------------------------------------------------------

class TestSaveTrajectoryAnalysisResult(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_dir = os.getcwd()
        os.chdir(self.tmpdir)

    def tearDown(self):
        os.chdir(self.orig_dir)

    def _read_saved(self):
        with open("proposal.json") as f:
            return json.load(f)

    def test_valid_json_object_saved(self):
        data = {"proposals": [_minimal_proposal()]}
        msg = save_trajectory_analysis_result(json.dumps(data))
        self.assertIn("Successfully saved", msg)
        saved = self._read_saved()
        self.assertEqual(saved["proposals"][0]["target_asset"]["name"], "proj.dataset.table.cost")

    def test_raw_list_wrapped_in_proposals_key(self):
        proposals = [_minimal_proposal()]
        save_trajectory_analysis_result(json.dumps(proposals))
        saved = self._read_saved()
        self.assertIn("proposals", saved)
        self.assertEqual(len(saved["proposals"]), 1)

    def test_empty_proposals_list_saved(self):
        save_trajectory_analysis_result(json.dumps({"proposals": []}))
        saved = self._read_saved()
        self.assertEqual(saved["proposals"], [])

    def test_pii_redacted_before_saving(self):
        proposal = _minimal_proposal()
        proposal["evidence"]["trajectory_quote"] = "user SSN is 123-45-6789"
        save_trajectory_analysis_result(json.dumps({"proposals": [proposal]}))
        saved = self._read_saved()
        quote = saved["proposals"][0]["evidence"]["trajectory_quote"]
        self.assertNotIn("123-45-6789", quote)
        self.assertIn("[SSN REDACTED]", quote)

    def test_invalid_backslash_escape_in_sql_repaired(self):
        # \s is not a valid JSON escape sequence — simulates LLM output with raw SQL
        raw = r'{"proposals": [{"golden_sql": "SELECT * FROM t WHERE x = \s"}]}'
        msg = save_trajectory_analysis_result(raw)
        self.assertIn("Successfully saved", msg)

    def test_returns_filename_in_message(self):
        msg = save_trajectory_analysis_result(json.dumps({"proposals": []}))
        self.assertIn("proposal.json", msg)


# ---------------------------------------------------------------------------
# _parse_reasoning_engine_labels
# ---------------------------------------------------------------------------

class TestParseReasoningEngineLabels(unittest.TestCase):

    def _labels(self, input_msgs=None, output_msgs=None):
        labels = {}
        if input_msgs is not None:
            labels["gen_ai.input.messages"] = json.dumps(input_msgs)
        if output_msgs is not None:
            labels["gen_ai.output.messages"] = json.dumps(output_msgs)
        return labels

    def test_returns_false_for_empty_labels(self):
        output = []
        self.assertFalse(_parse_reasoning_engine_labels({}, output))
        self.assertEqual(output, [])

    def test_returns_true_with_input_messages_label(self):
        labels = self._labels(input_msgs=[{"role": "user", "parts": [{"text": "hello"}]}])
        output = []
        self.assertTrue(_parse_reasoning_engine_labels(labels, output))

    def test_message_text_appears_in_output(self):
        labels = self._labels(input_msgs=[{"role": "user", "parts": [{"text": "what is cost?"}]}])
        output = []
        _parse_reasoning_engine_labels(labels, output)
        self.assertTrue(any("what is cost?" in line for line in output))

    def test_role_uppercased_in_output(self):
        labels = self._labels(input_msgs=[{"role": "user", "parts": [{"text": "hi"}]}])
        output = []
        _parse_reasoning_engine_labels(labels, output)
        self.assertTrue(any("[USER]:" in line for line in output))

    def test_tool_call_part_formatted(self):
        msg = {"role": "assistant", "parts": [{"name": "run_sql", "arguments": {"query": "SELECT 1"}}]}
        labels = self._labels(input_msgs=[msg])
        output = []
        _parse_reasoning_engine_labels(labels, output)
        self.assertTrue(any("Tool Call: run_sql" in line for line in output))

    def test_content_part_included(self):
        msg = {"role": "assistant", "parts": [{"content": "here is the answer"}]}
        labels = self._labels(input_msgs=[msg])
        output = []
        _parse_reasoning_engine_labels(labels, output)
        self.assertTrue(any("here is the answer" in line for line in output))

    def test_separator_added_after_each_message(self):
        labels = self._labels(input_msgs=[
            {"role": "user", "parts": [{"text": "q1"}]},
            {"role": "assistant", "parts": [{"text": "a1"}]},
        ])
        output = []
        _parse_reasoning_engine_labels(labels, output)
        separators = [l for l in output if l == "-" * 20]
        self.assertEqual(len(separators), 2)

    def test_malformed_json_in_labels_handled_gracefully(self):
        labels = {"gen_ai.input.messages": "not-valid-json"}
        output = []
        result = _parse_reasoning_engine_labels(labels, output)
        self.assertTrue(result)
        self.assertTrue(any("Error" in line for line in output))

    def test_both_input_and_output_messages_combined(self):
        labels = self._labels(
            input_msgs=[{"role": "user", "parts": [{"text": "query"}]}],
            output_msgs=[{"role": "assistant", "parts": [{"text": "answer"}]}],
        )
        output = []
        _parse_reasoning_engine_labels(labels, output)
        full = "\n".join(output)
        self.assertIn("query", full)
        self.assertIn("answer", full)


# ---------------------------------------------------------------------------
# _parse_generic_payload
# ---------------------------------------------------------------------------

class TestParseGenericPayload(unittest.TestCase):

    def test_string_payload_included_in_output(self):
        output = []
        _parse_generic_payload("hello world", output)
        self.assertTrue(any("hello world" in line for line in output))

    def test_dict_user_message(self):
        payload = {"message": {"user_message": {"text": "user asked this"}}}
        output = []
        _parse_generic_payload(payload, output)
        full = "\n".join(output)
        self.assertIn("[USER]", full)
        self.assertIn("user asked this", full)

    def test_dict_system_message(self):
        payload = {"message": {"system_message": {"text": "system instruction"}}}
        output = []
        _parse_generic_payload(payload, output)
        self.assertTrue(any("[SYSTEM]" in line for line in output))

    def test_dict_with_text_field(self):
        output = []
        _parse_generic_payload({"text": "direct text content"}, output)
        self.assertTrue(any("direct text content" in line for line in output))

    def test_dict_with_message_field(self):
        output = []
        _parse_generic_payload({"message": "simple message string"}, output)
        self.assertTrue(any("simple message string" in line for line in output))

    def test_non_string_non_dict_converted_to_string(self):
        output = []
        _parse_generic_payload(42, output)
        self.assertTrue(any("42" in line for line in output))

    def test_separator_always_last_element(self):
        output = []
        _parse_generic_payload("anything", output)
        self.assertEqual(output[-1], "-" * 20)


# ---------------------------------------------------------------------------
# get_agent_trajectories
# ---------------------------------------------------------------------------

class TestGetAgentTrajectories(unittest.TestCase):

    @patch("conversation_learner.agent.cloud_logging")
    def test_no_params_returns_error_message(self, mock_logging):
        result = get_agent_trajectories(project_id="test-project")
        self.assertIn("Either conversation_id", result)

    @patch("conversation_learner.agent.cloud_logging")
    def test_conversation_id_no_entries_returns_not_found(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_client.list_entries.return_value = []

        result = get_agent_trajectories(conversation_id="abc123", project_id="test-project")
        self.assertIn("No messages found", result)

    @patch("conversation_learner.agent.cloud_logging")
    def test_reasoning_engine_deduplicates_by_conversation_id(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"

        # 3 entries, 2 unique conversation IDs — first seen (= latest) wins
        entries = [
            _make_log_entry("conv-1", gen_ai_labels=True),
            _make_log_entry("conv-2", gen_ai_labels=True),
            _make_log_entry("conv-1"),  # duplicate, should be ignored
        ]
        mock_client.list_entries.return_value = entries

        result = get_agent_trajectories(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7,
            project_id="test-project",
        )
        self.assertIn("Unique conversations: 2", result)

    @patch("conversation_learner.agent.cloud_logging")
    def test_conversation_ids_printed_in_output(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"

        mock_client.list_entries.return_value = [_make_log_entry("conv-abc", gen_ai_labels=True)]

        result = get_agent_trajectories(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7,
            project_id="test-project",
        )
        self.assertIn("Conversation IDs:", result)
        self.assertIn("conv-abc", result)

    @patch("conversation_learner.agent.cloud_logging")
    def test_entries_without_conversation_id_skipped(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"

        entries = [
            _make_log_entry(conversation_id=None),       # no label — skipped
            _make_log_entry("conv-1", gen_ai_labels=True),
        ]
        mock_client.list_entries.return_value = entries

        result = get_agent_trajectories(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7,
            project_id="test-project",
        )
        self.assertIn("Unique conversations: 1", result)

    @patch("conversation_learner.agent.cloud_logging")
    def test_reasoning_engine_no_entries_returns_not_found(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"
        mock_client.list_entries.return_value = []

        result = get_agent_trajectories(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7,
            project_id="test-project",
        )
        self.assertIn("No messages found", result)

    @patch("conversation_learner.agent.cloud_logging")
    def test_full_resource_path_id_extracted(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"
        mock_client.list_entries.return_value = []

        get_agent_trajectories(
            reasoning_engine_id="projects/my-proj/locations/us-central1/reasoningEngines/1234567890123456789",
            days_ago=7,
            project_id="test-project",
        )
        call_kwargs = mock_client.list_entries.call_args.kwargs
        self.assertIn("1234567890123456789", call_kwargs["filter_"])
        self.assertNotIn("projects/my-proj/locations/us-central1/reasoningEngines/", call_kwargs["filter_"])

    @patch("conversation_learner.agent.cloud_logging")
    def test_start_and_end_time_included_in_filter(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"
        mock_client.list_entries.return_value = []

        get_agent_trajectories(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            start_time="2026-06-01T00:00:00Z",
            end_time="2026-06-17T00:00:00Z",
            project_id="test-project",
        )
        call_kwargs = mock_client.list_entries.call_args.kwargs
        self.assertIn("2026-06-01T00:00:00Z", call_kwargs["filter_"])
        self.assertIn("2026-06-17T00:00:00Z", call_kwargs["filter_"])

    @patch("conversation_learner.agent.cloud_logging")
    def test_total_log_entry_count_in_output(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"

        entries = [_make_log_entry("conv-1", gen_ai_labels=True)] * 5
        mock_client.list_entries.return_value = entries

        result = get_agent_trajectories(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7,
            project_id="test-project",
        )
        self.assertIn("Total log entries retrieved: 5", result)


if __name__ == "__main__":
    unittest.main()
