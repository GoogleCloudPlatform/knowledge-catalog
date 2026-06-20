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

import asyncio
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

# Required before importing agent — get_consumer_project() reads this at module level.
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")

# Add agents/ to sys.path so `conversation_learner` is importable as a package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from conversation_learner.agent import (  # noqa: E402
    _aggregate_proposals,
    _canonical_asset_name,
    _conversation_filter,
    _format_message,
    _group_by_conversation,
    _parse_generic_payload,
    _proposal_id,
    _reasoning_engine_filter,
    _redact_obj,
    _redact_sensitive,
    _render_conversation,
    _tolerant_json_array,
    generate_learnings,
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
    entry.timestamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
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
# _tolerant_json_array
# ---------------------------------------------------------------------------

class TestTolerantJsonArray(unittest.TestCase):

    def test_valid_array_parses(self):
        elements, truncated = _tolerant_json_array('[{"a": 1}, {"b": 2}]')
        self.assertEqual(elements, [{"a": 1}, {"b": 2}])
        self.assertFalse(truncated)

    def test_empty_string(self):
        self.assertEqual(_tolerant_json_array(""), ([], False))

    def test_garbage_returns_empty_and_truncated(self):
        elements, truncated = _tolerant_json_array("not-json")
        self.assertEqual(elements, [])
        self.assertTrue(truncated)

    def test_truncated_array_salvages_complete_elements(self):
        # Simulates Cloud Logging cutting the value off mid second element.
        full = json.dumps([
            {"role": "user", "parts": [{"text": "keep me"}]},
            {"role": "assistant", "parts": [{"text": "X" * 200}]},
        ])
        chopped = full[:-30]
        elements, truncated = _tolerant_json_array(chopped)
        self.assertTrue(truncated)
        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["parts"][0]["text"], "keep me")


# ---------------------------------------------------------------------------
# _format_message
# ---------------------------------------------------------------------------

class TestFormatMessage(unittest.TestCase):

    def test_text_part(self):
        self.assertEqual(
            _format_message({"role": "user", "parts": [{"text": "hi there"}]}),
            "[USER]: hi there",
        )

    def test_content_part(self):
        out = _format_message({"role": "assistant", "parts": [{"content": "here is the answer"}]})
        self.assertIn("here is the answer", out)

    def test_tool_call_part_formatted(self):
        msg = {"role": "assistant", "parts": [{"name": "run_sql", "arguments": {"query": "SELECT 1"}}]}
        self.assertIn("Tool Call: run_sql", _format_message(msg))

    def test_role_uppercased(self):
        self.assertTrue(_format_message({"role": "user", "parts": []}).startswith("[USER]:"))

    def test_non_dict_message_handled(self):
        self.assertIn("UNKNOWN", _format_message("just a string"))


# ---------------------------------------------------------------------------
# _render_conversation
# ---------------------------------------------------------------------------

class TestRenderConversation(unittest.TestCase):

    def _entry(self, input_msgs=None, output_msgs=None, ts=0, payload="log line", conv="c1"):
        """Mock log entry; *_msgs may be a list (json-encoded) or a raw string."""
        entry = MagicMock()
        labels = {"gen_ai.conversation.id": conv}
        if input_msgs is not None:
            labels["gen_ai.input.messages"] = (
                input_msgs if isinstance(input_msgs, str) else json.dumps(input_msgs)
            )
        if output_msgs is not None:
            labels["gen_ai.output.messages"] = (
                output_msgs if isinstance(output_msgs, str) else json.dumps(output_msgs)
            )
        entry.to_api_repr.return_value = {"labels": labels}
        entry.timestamp = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=ts)
        entry.payload = payload
        return entry

    def test_single_entry_input_and_output(self):
        entry = self._entry(
            input_msgs=[{"role": "user", "parts": [{"text": "the question"}]}],
            output_msgs=[{"role": "assistant", "parts": [{"text": "the answer"}]}],
        )
        output = []
        _render_conversation([entry], output)
        full = "\n".join(output)
        self.assertIn("the question", full)
        self.assertIn("the answer", full)

    def test_separator_added_after_each_message(self):
        entry = self._entry(
            input_msgs=[
                {"role": "user", "parts": [{"text": "q1"}]},
                {"role": "assistant", "parts": [{"text": "a1"}]},
            ],
        )
        output = []
        _render_conversation([entry], output)
        self.assertEqual(len([l for l in output if l == "-" * 20]), 2)

    def test_messages_deduplicated_across_entries(self):
        # The later entry's input repeats the first turn (accumulated history).
        e1 = self._entry(
            input_msgs=[{"role": "user", "parts": [{"text": "turn one"}]}],
            output_msgs=[{"role": "assistant", "parts": [{"text": "reply one"}]}],
            ts=0,
        )
        e2 = self._entry(
            input_msgs=[
                {"role": "user", "parts": [{"text": "turn one"}]},
                {"role": "assistant", "parts": [{"text": "reply one"}]},
                {"role": "user", "parts": [{"text": "turn two"}]},
            ],
            output_msgs=[{"role": "assistant", "parts": [{"text": "reply two"}]}],
            ts=1,
        )
        output = []
        _render_conversation([e2, e1], output)  # deliberately out of chronological order
        full = "\n".join(output)
        self.assertEqual(full.count("turn one"), 1)  # deduped despite appearing twice
        for txt in ("turn one", "reply one", "turn two", "reply two"):
            self.assertIn(txt, full)

    def test_truncated_last_entry_backfilled_by_earlier(self):
        # Chronologically last entry's input label is truncated to invalid JSON,
        # but the earlier (smaller) entry still holds the opening turn.
        good_input = json.dumps([{"role": "user", "parts": [{"text": "original question"}]}])
        big = json.dumps([
            {"role": "user", "parts": [{"text": "original question"}]},
            {"role": "tool", "parts": [{"text": "Y" * 500}]},
        ])
        truncated_input = big[:-40]
        e1 = self._entry(
            input_msgs=good_input,
            output_msgs=[{"role": "assistant", "parts": [{"text": "tool call"}]}],
            ts=0,
        )
        e2 = self._entry(
            input_msgs=truncated_input,
            output_msgs=[{"role": "assistant", "parts": [{"text": "final answer"}]}],
            ts=1,
        )
        output = []
        _render_conversation([e1, e2], output)
        full = "\n".join(output)
        self.assertIn("original question", full)  # recovered from the earlier entry
        self.assertIn("final answer", full)       # from the last entry's small output label
        self.assertIn("truncated", full.lower())  # truncation note emitted

    def test_no_message_labels_falls_back_to_payload(self):
        entry = self._entry(payload="raw payload text")  # no gen_ai message labels
        output = []
        _render_conversation([entry], output)
        self.assertTrue(any("raw payload text" in line for line in output))


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

        # 3 entries, 2 unique conversation IDs — entries are grouped/merged per id
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


# ---------------------------------------------------------------------------
# Cloud Logging filter builders
# ---------------------------------------------------------------------------

class TestFilters(unittest.TestCase):

    def test_conversation_filter_pins_id_and_resource_type(self):
        f = _conversation_filter("conv-123")
        self.assertIn('resource.type="aiplatform.googleapis.com/ReasoningEngine"', f)
        self.assertIn('labels."gen_ai.conversation.id"="conv-123"', f)

    def test_reasoning_engine_filter_requires_nonempty_conversation_id(self):
        f = _reasoning_engine_filter("123", "2026-06-05T00:00:00+00:00")
        self.assertIn('resource.labels.reasoning_engine_id="123"', f)
        self.assertIn('labels."gen_ai.conversation.id"!=""', f)
        self.assertIn('timestamp>="2026-06-05T00:00:00+00:00"', f)
        self.assertNotIn("timestamp<=", f)

    def test_reasoning_engine_filter_includes_end_time(self):
        f = _reasoning_engine_filter("123", "2026-06-01T00:00:00Z", "2026-06-17T00:00:00Z")
        self.assertIn('timestamp<="2026-06-17T00:00:00Z"', f)


# ---------------------------------------------------------------------------
# _group_by_conversation
# ---------------------------------------------------------------------------

class TestGroupByConversation(unittest.TestCase):

    def test_groups_entries_and_skips_unlabeled(self):
        entries = [
            _make_log_entry("c1", gen_ai_labels=True),
            _make_log_entry("c2", gen_ai_labels=True),
            _make_log_entry("c1"),
            _make_log_entry(conversation_id=None),  # no id — skipped
        ]
        grouped = _group_by_conversation(entries)
        self.assertEqual(set(grouped.keys()), {"c1", "c2"})
        self.assertEqual(len(grouped["c1"]), 2)
        self.assertEqual(len(grouped["c2"]), 1)


# ---------------------------------------------------------------------------
# _aggregate_proposals
# ---------------------------------------------------------------------------

class TestAggregateProposals(unittest.TestCase):

    def _p(self, name, gap="BUSINESS_LOGIC_GAP", atype="COLUMN", conf=0.5, instr="do X"):
        return {
            "classification": {"detection_signal": "DIRECT_USER_CORRECTION", "gap_type": gap},
            "target_asset": {"type": atype, "name": name},
            "proposed_enrichment": {"action": "UPDATE_OVERVIEW_ASPECT", "value": "v"},
            "confidence_grade": conf,
            "enrichment_agent_instruction": instr,
        }

    def test_same_asset_and_gap_collapsed_keeping_higher_confidence(self):
        out = _aggregate_proposals([self._p("ds.t.col", conf=0.6), self._p("DS.T.COL", conf=0.9)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["confidence_grade"], 0.9)

    def test_different_gap_type_not_merged(self):
        out = _aggregate_proposals([
            self._p("ds.t.col", gap="BUSINESS_LOGIC_GAP"),
            self._p("ds.t.col", gap="STRUCTURAL_ROUTING_GAP"),
        ])
        self.assertEqual(len(out), 2)

    def test_different_asset_not_merged(self):
        out = _aggregate_proposals([self._p("ds.t.a"), self._p("ds.t.b")])
        self.assertEqual(len(out), 2)

    def test_blank_name_distinct_instructions_not_collapsed(self):
        out = _aggregate_proposals([
            self._p("", atype="UNCATALOGED_ASSET", gap="UNCATALOGED_ASSET_DISCOVERY", instr="catalog table A"),
            self._p("", atype="UNCATALOGED_ASSET", gap="UNCATALOGED_ASSET_DISCOVERY", instr="catalog table B"),
        ])
        self.assertEqual(len(out), 2)

    def test_blank_name_same_instruction_collapsed(self):
        out = _aggregate_proposals([
            self._p("", atype="UNCATALOGED_ASSET", gap="UNCATALOGED_ASSET_DISCOVERY", instr="catalog A", conf=0.4),
            self._p("", atype="UNCATALOGED_ASSET", gap="UNCATALOGED_ASSET_DISCOVERY", instr="catalog A", conf=0.8),
        ])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["confidence_grade"], 0.8)


# ---------------------------------------------------------------------------
# _canonical_asset_name
# ---------------------------------------------------------------------------

class TestCanonicalAssetName(unittest.TestCase):

    def test_drops_hyphenated_project_prefix(self):
        self.assertEqual(
            _canonical_asset_name("weiyi-test-dataplex.weiyiaidataset.monthly_cloud_billing.cost"),
            "weiyiaidataset.monthly_cloud_billing.cost",
        )

    def test_no_project_unchanged(self):
        self.assertEqual(
            _canonical_asset_name("weiyiaidataset.monthly_cloud_billing.cost"),
            "weiyiaidataset.monthly_cloud_billing.cost",
        )

    def test_drops_four_part_project_without_hyphen(self):
        self.assertEqual(_canonical_asset_name("proj.ds.tbl.col"), "ds.tbl.col")

    def test_hyphenated_project_three_part_table(self):
        self.assertEqual(
            _canonical_asset_name("dataplex-demo.demo_concord_tables.analysis_x"),
            "demo_concord_tables.analysis_x",
        )

    def test_project_plus_dataset(self):
        self.assertEqual(_canonical_asset_name("weiyi-test-dataplex.weiyi_kb_0"), "weiyi_kb_0")

    def test_single_component_unchanged(self):
        self.assertEqual(_canonical_asset_name("weiyi_kb_0"), "weiyi_kb_0")

    def test_glossary_term_not_path_stripped(self):
        self.assertEqual(_canonical_asset_name("foo-bar.baz", "GLOSSARY_TERM"), "foo-bar.baz")

    def test_lowercases_and_handles_empty(self):
        self.assertEqual(_canonical_asset_name("DS.T.COL"), "ds.t.col")
        self.assertEqual(_canonical_asset_name(None), "")


# ---------------------------------------------------------------------------
# _proposal_id
# ---------------------------------------------------------------------------

class TestProposalId(unittest.TestCase):

    def _p(self, name="ds.t.col", gap="BUSINESS_LOGIC_GAP", atype="COLUMN", value="v", instr="do X"):
        return {
            "classification": {"detection_signal": "DIRECT_USER_CORRECTION", "gap_type": gap},
            "target_asset": {"type": atype, "name": name},
            "proposed_enrichment": {"action": "UPDATE_OVERVIEW_ASPECT", "value": value},
            "confidence_grade": 0.9,
            "enrichment_agent_instruction": instr,
        }

    def test_deterministic_and_prefixed(self):
        self.assertEqual(_proposal_id(self._p()), _proposal_id(self._p()))
        self.assertTrue(_proposal_id(self._p()).startswith("prop_"))

    def test_independent_of_proposed_value(self):
        # The whole point: re-phrased value must NOT change the id.
        self.assertEqual(
            _proposal_id(self._p(value="unit is thousands of dollars")),
            _proposal_id(self._p(value="values are in 1000s of USD")),
        )

    def test_changes_with_gap_type(self):
        self.assertNotEqual(
            _proposal_id(self._p(gap="BUSINESS_LOGIC_GAP")),
            _proposal_id(self._p(gap="STRUCTURAL_ROUTING_GAP")),
        )

    def test_changes_with_asset(self):
        self.assertNotEqual(_proposal_id(self._p(name="ds.t.a")), _proposal_id(self._p(name="ds.t.b")))

    def test_normalizes_asset_name_case(self):
        self.assertEqual(_proposal_id(self._p(name="DS.T.COL")), _proposal_id(self._p(name="ds.t.col")))

    def test_stable_across_project_prefix(self):
        # The caveat fix: same asset with vs without the project prefix -> same id.
        self.assertEqual(
            _proposal_id(self._p(name="weiyi-test-dataplex.weiyiaidataset.monthly_cloud_billing.cost")),
            _proposal_id(self._p(name="weiyiaidataset.monthly_cloud_billing.cost")),
        )

    def test_id_matches_dedup_identity(self):
        # Two proposals the dedup collapses into one must share the same id.
        a, b = self._p(value="x", instr="i1"), self._p(value="y", instr="i2")
        self.assertEqual(_proposal_id(a), _proposal_id(b))
        self.assertEqual(len(_aggregate_proposals([a, b])), 1)


# ---------------------------------------------------------------------------
# generate_learnings (per-conversation fan-out + dedup orchestration)
# ---------------------------------------------------------------------------

class TestGenerateLearnings(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.orig_dir = os.getcwd()
        os.chdir(self.tmpdir)  # proposal.json is written to cwd

    def tearDown(self):
        os.chdir(self.orig_dir)

    def _proposal(self, name="ds.t.cost", gap="BUSINESS_LOGIC_GAP", conf=0.9):
        return {
            "classification": {"detection_signal": "DIRECT_USER_CORRECTION", "gap_type": gap},
            "target_asset": {"type": "COLUMN", "name": name},
            "proposed_enrichment": {"action": "UPDATE_OVERVIEW_ASPECT", "value": "USD"},
            "confidence_grade": conf,
            "enrichment_agent_instruction": "update cost",
        }

    @patch("conversation_learner.agent._judge_conversation_sync")
    @patch("conversation_learner.agent.cloud_logging")
    def test_validation_error_when_no_params(self, mock_logging, mock_judge):
        result = asyncio.run(generate_learnings(project_id="test-project"))
        self.assertIn("Either conversation_id", result)
        mock_judge.assert_not_called()

    @patch("conversation_learner.agent._judge_conversation_sync")
    @patch("conversation_learner.agent.cloud_logging")
    def test_fans_out_per_conversation_and_dedups(self, mock_logging, mock_judge):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"
        mock_client.list_entries.return_value = [
            _make_log_entry("c1", gen_ai_labels=True),
            _make_log_entry("c2", gen_ai_labels=True),
        ]
        # Both conversations surface the SAME asset+gap proposal -> dedup to 1.
        mock_judge.return_value = [self._proposal()]

        result = asyncio.run(generate_learnings(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7, project_id="test-project",
        ))

        self.assertEqual(mock_judge.call_count, 2)  # one judge call per conversation
        self.assertIn("Unique conversations: 2", result)
        self.assertIn("from 2 raw", result)
        self.assertIn("saved 1 deduplicated", result)
        with open("proposal.json") as f:
            saved = json.load(f)
        self.assertEqual(len(saved["proposals"]), 1)

    @patch("conversation_learner.agent._judge_conversation_sync")
    @patch("conversation_learner.agent.cloud_logging")
    def test_one_conversation_failure_does_not_abort_batch(self, mock_logging, mock_judge):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"
        mock_client.list_entries.return_value = [
            _make_log_entry("c1", gen_ai_labels=True),
            _make_log_entry("c2", gen_ai_labels=True),
        ]

        def _side_effect(cid, transcript):
            if cid == "c1":
                raise RuntimeError("boom")  # non-retryable -> conversation yields []
            return [self._proposal(name="ds.t.other")]
        mock_judge.side_effect = _side_effect

        result = asyncio.run(generate_learnings(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7, project_id="test-project",
        ))
        self.assertIn("from 1 raw", result)
        self.assertIn("saved 1 deduplicated", result)

    @patch("conversation_learner.agent.cloud_logging")
    def test_no_conversations_found(self, mock_logging):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"
        mock_client.list_entries.return_value = []
        result = asyncio.run(generate_learnings(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7, project_id="test-project",
        ))
        self.assertIn("Unique conversations: 0", result)

    def _run_one(self, mock_logging, mock_judge, include_ids):
        mock_client = MagicMock()
        mock_logging.Client.return_value = mock_client
        mock_logging.DESCENDING = "DESCENDING"
        mock_client.list_entries.return_value = [_make_log_entry("c1", gen_ai_labels=True)]
        mock_judge.return_value = [self._proposal()]
        asyncio.run(generate_learnings(
            reasoning_engine_id="projects/p/locations/l/reasoningEngines/123",
            days_ago=7, project_id="test-project", include_ids=include_ids,
        ))
        with open("proposal.json") as f:
            return json.load(f)["proposals"]

    @patch("conversation_learner.agent._judge_conversation_sync")
    @patch("conversation_learner.agent.cloud_logging")
    def test_include_ids_adds_id_field(self, mock_logging, mock_judge):
        proposals = self._run_one(mock_logging, mock_judge, include_ids=True)
        self.assertTrue(proposals and all(p.get("id", "").startswith("prop_") for p in proposals))

    @patch("conversation_learner.agent._judge_conversation_sync")
    @patch("conversation_learner.agent.cloud_logging")
    def test_no_ids_by_default(self, mock_logging, mock_judge):
        proposals = self._run_one(mock_logging, mock_judge, include_ids=False)
        self.assertTrue(proposals and all("id" not in p for p in proposals))


if __name__ == "__main__":
    unittest.main()
