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

"""Unit tests for the ConversationLearner CLI."""

import os
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Required before importing the agent — get_consumer_project() reads this at module level.
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")

# Add agents/ to sys.path so `conversation_learner` is importable as a package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from conversation_learner import cli  # noqa: E402

_RE = "projects/p/locations/l/reasoningEngines/123"


# ---------------------------------------------------------------------------
# _resolve_output
# ---------------------------------------------------------------------------

class TestResolveOutput(unittest.TestCase):

    def test_none_defaults_to_proposal_json(self):
        self.assertEqual(cli._resolve_output(None), "proposal.json")

    def test_empty_defaults_to_proposal_json(self):
        self.assertEqual(cli._resolve_output(""), "proposal.json")

    def test_file_path_passed_through(self):
        self.assertEqual(cli._resolve_output("/a/b/out.json"), "/a/b/out.json")

    def test_existing_directory_gets_proposal_json_appended(self):
        d = tempfile.mkdtemp()
        self.assertEqual(cli._resolve_output(d), os.path.join(d, "proposal.json"))

    def test_trailing_sep_treated_as_directory(self):
        raw = "some_dir" + os.sep
        self.assertEqual(cli._resolve_output(raw), os.path.join("some_dir", "proposal.json"))


# ---------------------------------------------------------------------------
# Flags mode — dispatch to generate_learnings
# ---------------------------------------------------------------------------

class TestFlagsDispatch(unittest.TestCase):

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_reasoning_engine_and_days_forwarded(self, mock_gen):
        mock_gen.return_value = "Total log entries retrieved: 3. Unique conversations: 1."
        rc = cli.main(["--reasoning_engine_id", _RE, "--days_ago", "7", "--project", "test-project"])
        self.assertEqual(rc, 0)
        mock_gen.assert_called_once_with(
            conversation_id=None,
            reasoning_engine_id=_RE,
            days_ago=7,
            start_time=None,
            end_time=None,
            project_id="test-project",
            include_ids=False,
        )

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_conversation_id_forwarded(self, mock_gen):
        mock_gen.return_value = "ok"
        cli.main(["--conversation_id", "abc123", "--project", "test-project"])
        kwargs = mock_gen.call_args.kwargs
        self.assertEqual(kwargs["conversation_id"], "abc123")
        self.assertIsNone(kwargs["reasoning_engine_id"])

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_include_ids_flag(self, mock_gen):
        mock_gen.return_value = "ok"
        cli.main(["--conversation_id", "abc", "--include_ids", "--project", "test-project"])
        self.assertTrue(mock_gen.call_args.kwargs["include_ids"])

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_start_and_end_time_forwarded(self, mock_gen):
        mock_gen.return_value = "ok"
        cli.main([
            "--reasoning_engine_id", _RE,
            "--start_time", "2026-06-01T00:00:00Z",
            "--end_time", "2026-06-17T00:00:00Z",
            "--project", "test-project",
        ])
        kwargs = mock_gen.call_args.kwargs
        self.assertEqual(kwargs["start_time"], "2026-06-01T00:00:00Z")
        self.assertEqual(kwargs["end_time"], "2026-06-17T00:00:00Z")

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_error_summary_returns_nonzero(self, mock_gen):
        mock_gen.return_value = "API Error: boom"
        rc = cli.main(["--conversation_id", "abc", "--project", "test-project"])
        self.assertEqual(rc, 1)


# ---------------------------------------------------------------------------
# Prompt mode — dispatch to the ADK agent
# ---------------------------------------------------------------------------

class TestPromptDispatch(unittest.TestCase):

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    @patch("conversation_learner.cli._run_prompt", return_value="done")
    def test_prompt_routes_to_run_prompt(self, mock_prompt, mock_gen):
        rc = cli.main(["--prompt", "generate learnings for X in the past 7 days", "--project", "test-project"])
        self.assertEqual(rc, 0)
        mock_prompt.assert_called_once_with("generate learnings for X in the past 7 days")
        mock_gen.assert_not_called()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class TestValidation(unittest.TestCase):

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_no_selectors_exits_2(self, mock_gen):
        with self.assertRaises(SystemExit) as cm:
            cli.main([])
        self.assertEqual(cm.exception.code, 2)
        mock_gen.assert_not_called()

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_reasoning_engine_without_window_exits_2(self, mock_gen):
        with self.assertRaises(SystemExit) as cm:
            cli.main(["--reasoning_engine_id", _RE, "--project", "test-project"])
        self.assertEqual(cm.exception.code, 2)
        mock_gen.assert_not_called()

    @patch("conversation_learner.cli._run_prompt", return_value="x")
    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_prompt_with_selector_exits_2(self, mock_gen, mock_prompt):
        with self.assertRaises(SystemExit) as cm:
            cli.main(["--prompt", "x", "--days_ago", "7", "--project", "test-project"])
        self.assertEqual(cm.exception.code, 2)
        mock_prompt.assert_not_called()
        mock_gen.assert_not_called()

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_missing_project_exits_2(self, mock_gen):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GOOGLE_CLOUD_PROJECT", None)
            with self.assertRaises(SystemExit) as cm:
                cli.main(["--conversation_id", "abc"])
            self.assertEqual(cm.exception.code, 2)
        mock_gen.assert_not_called()


# ---------------------------------------------------------------------------
# Environment + output wiring
# ---------------------------------------------------------------------------

class TestEnvAndOutput(unittest.TestCase):

    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_project_and_location_set_in_env(self, mock_gen):
        mock_gen.return_value = "ok"
        with patch.dict(os.environ, {}, clear=False):
            cli.main([
                "--conversation_id", "abc",
                "--project", "my-proj",
                "--location", "us-central1",
            ])
            self.assertEqual(os.environ["GOOGLE_CLOUD_PROJECT"], "my-proj")
            self.assertEqual(os.environ["GOOGLE_CLOUD_LOCATION"], "us-central1")
        self.assertEqual(mock_gen.call_args.kwargs["project_id"], "my-proj")

    @patch("conversation_learner.agent.set_default_output_path")
    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_output_file_path_sets_default(self, mock_gen, mock_set):
        mock_gen.return_value = "ok"
        cli.main(["--conversation_id", "abc", "--project", "test-project", "--output", "/tmp/out.json"])
        mock_set.assert_called_once_with("/tmp/out.json")

    @patch("conversation_learner.agent.set_default_output_path")
    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_output_directory_appends_proposal_json(self, mock_gen, mock_set):
        mock_gen.return_value = "ok"
        d = tempfile.mkdtemp()
        cli.main(["--conversation_id", "abc", "--project", "test-project", "--output", d])
        mock_set.assert_called_once_with(os.path.join(d, "proposal.json"))

    @patch("conversation_learner.agent.set_default_output_path")
    @patch("conversation_learner.agent.generate_learnings", new_callable=AsyncMock)
    def test_output_defaults_to_proposal_json(self, mock_gen, mock_set):
        mock_gen.return_value = "ok"
        cli.main(["--conversation_id", "abc", "--project", "test-project"])
        mock_set.assert_called_once_with("proposal.json")


if __name__ == "__main__":
    unittest.main()
