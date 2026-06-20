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

"""Unit tests for review_store (HITL review state). No GCP deps required."""

import json
import os
import sys
import tempfile
import unittest

# Add agents/ so `conversation_learner` is importable as a package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from conversation_learner import review_store as rs  # noqa: E402


def _proposal(name="ds.t.col", gap="BUSINESS_LOGIC_GAP", atype="COLUMN", conf=0.9, pid=None):
    p = {
        "classification": {"detection_signal": "DIRECT_USER_CORRECTION", "gap_type": gap},
        "target_asset": {"type": atype, "name": name},
        "proposed_enrichment": {"action": "UPDATE_OVERVIEW_ASPECT", "value": "v"},
        "confidence_grade": conf,
        "enrichment_agent_instruction": "do X",
    }
    if pid:
        p["id"] = pid
    return p


class TestReviewStore(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.proposals_path = os.path.join(self.tmp, "proposal.json")
        self.reviews_path = os.path.join(self.tmp, "reviews.json")
        self.approved_path = os.path.join(self.tmp, "approved.json")

    def _dump(self, proposals):
        with open(self.proposals_path, "w") as f:
            json.dump({"proposals": proposals}, f)

    # --- load_proposals ---

    def test_load_computes_id_when_missing(self):
        self._dump([_proposal()])
        ps = rs.load_proposals(self.proposals_path)
        self.assertTrue(ps[0]["id"].startswith("prop_"))

    def test_load_keeps_existing_id(self):
        self._dump([_proposal(pid="prop_custom")])
        self.assertEqual(rs.load_proposals(self.proposals_path)[0]["id"], "prop_custom")

    def test_load_accepts_bare_list(self):
        with open(self.proposals_path, "w") as f:
            json.dump([_proposal()], f)
        self.assertEqual(len(rs.load_proposals(self.proposals_path)), 1)

    # --- reviews persistence (merge by id) ---

    def test_save_review_merges_by_id(self):
        rs.save_review("prop_a", "approved", path=self.reviews_path)
        rs.save_review("prop_b", "rejected", "bad", path=self.reviews_path)
        reviews = rs.load_reviews(self.reviews_path)
        self.assertEqual(reviews["prop_a"]["status"], "approved")
        self.assertEqual(reviews["prop_b"]["status"], "rejected")
        self.assertEqual(reviews["prop_b"]["note"], "bad")
        self.assertIn("reviewed_at", reviews["prop_a"])

    def test_save_review_rejects_invalid_status(self):
        with self.assertRaises(ValueError):
            rs.save_review("prop_a", "maybe", path=self.reviews_path)

    def test_load_reviews_missing_file(self):
        self.assertEqual(rs.load_reviews(self.reviews_path), {})

    # --- merge ---

    def test_merge_defaults_to_pending(self):
        ps = [_proposal(pid="prop_a"), _proposal(name="ds.t.b", pid="prop_b")]
        merged = {m["id"]: m for m in rs.merge(ps, {"prop_a": {"status": "approved"}})}
        self.assertEqual(merged["prop_a"]["status"], "approved")
        self.assertEqual(merged["prop_b"]["status"], "pending")

    # --- bulk_approve ---

    def test_bulk_approve_threshold_and_skips_reviewed(self):
        self._dump([
            _proposal(pid="p_hi", conf=0.95),
            _proposal(name="ds.t.lo", pid="p_lo", conf=0.4),
            _proposal(name="ds.t.rej", pid="p_rej", conf=0.99),
        ])
        ps = rs.load_proposals(self.proposals_path)
        rs.save_review("p_rej", "rejected", path=self.reviews_path)  # already reviewed
        n = rs.bulk_approve(ps, 0.8, path=self.reviews_path)
        self.assertEqual(n, 1)  # only p_hi (p_lo below threshold, p_rej already reviewed)
        reviews = rs.load_reviews(self.reviews_path)
        self.assertEqual(reviews["p_hi"]["status"], "approved")
        self.assertNotIn("p_lo", reviews)
        self.assertEqual(reviews["p_rej"]["status"], "rejected")  # untouched

    # --- export_approved ---

    def test_export_approved_only(self):
        ps = [_proposal(pid="p_a"), _proposal(name="ds.t.b", pid="p_b")]
        n = rs.export_approved(ps, {"p_a": {"status": "approved"}, "p_b": {"status": "rejected"}},
                               path=self.approved_path)
        self.assertEqual(n, 1)
        with open(self.approved_path) as f:
            out = json.load(f)
        self.assertEqual([p["id"] for p in out["proposals"]], ["p_a"])

    # --- summary ---

    def test_summary_counts(self):
        merged = rs.merge(
            [_proposal(pid="p_a", conf=0.9),
             _proposal(name="ds.t.b", gap="STRUCTURAL_ROUTING_GAP", pid="p_b", conf=0.4)],
            {"p_a": {"status": "approved"}},
        )
        s = rs.summary(merged)
        self.assertEqual(s["total"], 2)
        self.assertEqual(s["by_status"], {"approved": 1, "pending": 1})
        self.assertEqual(s["by_gap_type"]["BUSINESS_LOGIC_GAP"], 1)
        self.assertEqual(s["by_confidence_band"]["high (>=0.8)"], 1)
        self.assertEqual(s["by_confidence_band"]["low (<0.5)"], 1)


if __name__ == "__main__":
    unittest.main()
