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

"""File-backed human review state for ConversationLearner proposals (HITL demo).

Pure logic with no UI dependency (review_app.py is the Streamlit front-end), so
it is unit-testable. Fully local: reads ``proposal.json``, persists decisions to
``reviews.json`` keyed by the stable proposal id, and exports the approved subset
to ``approved_proposals.json`` as the hand-off to the Enrichment Agent.

Review state is keyed by the proposal id (not array position), so re-running the
agent and regenerating ``proposal.json`` never clobbers existing decisions.
"""

import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List

# Share the agent's exact id definition without importing its GCP/ADK runtime.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
from proposal_id import _proposal_id  # noqa: E402

DEFAULT_PROPOSALS_PATH = os.path.join(_HERE, "proposal.json")
DEFAULT_REVIEWS_PATH = os.path.join(_HERE, "reviews.json")
DEFAULT_APPROVED_PATH = os.path.join(_HERE, "approved_proposals.json")

STATUSES = ("pending", "approved", "rejected")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: str, data: Any) -> None:
    """Atomic write so a crash mid-save can't corrupt the review state."""
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def load_proposals(path: str = DEFAULT_PROPOSALS_PATH) -> List[Dict[str, Any]]:
    """Loads proposals, ensuring each has a stable ``id`` (computed if absent).

    Works whether ``proposal.json`` was generated with or without ``include_ids``
    — a missing id is filled with the same value the agent would have produced.
    """
    with open(path) as f:
        data = json.load(f)
    proposals = data["proposals"] if isinstance(data, dict) else data
    for p in proposals:
        if not p.get("id"):
            p["id"] = _proposal_id(p)
    return proposals


def load_reviews(path: str = DEFAULT_REVIEWS_PATH) -> Dict[str, Dict[str, Any]]:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def save_review(proposal_id: str, status: str, note: str = "",
                path: str = DEFAULT_REVIEWS_PATH) -> Dict[str, Dict[str, Any]]:
    """Records one decision, merged by id (other entries untouched)."""
    if status not in STATUSES:
        raise ValueError(f"invalid status {status!r}; expected one of {STATUSES}")
    reviews = load_reviews(path)
    reviews[proposal_id] = {"status": status, "note": note, "reviewed_at": _now()}
    _write_json(path, reviews)
    return reviews


def merge(proposals: List[Dict[str, Any]],
          reviews: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Annotates each proposal with its current ``status`` and ``review_note``."""
    merged = []
    for p in proposals:
        r = reviews.get(p["id"], {})
        merged.append({**p, "status": r.get("status", "pending"),
                       "review_note": r.get("note", "")})
    return merged


def bulk_approve(proposals: List[Dict[str, Any]], min_confidence: float,
                 path: str = DEFAULT_REVIEWS_PATH) -> int:
    """Approves every currently-pending proposal with confidence >= threshold.

    Already-reviewed proposals (approved or rejected) are left as-is. Returns the
    number newly approved.
    """
    reviews = load_reviews(path)
    n = 0
    for p in proposals:
        if reviews.get(p["id"], {}).get("status", "pending") != "pending":
            continue
        if (p.get("confidence_grade") or 0) >= min_confidence:
            reviews[p["id"]] = {"status": "approved",
                                "note": f"bulk approve (confidence >= {min_confidence})",
                                "reviewed_at": _now()}
            n += 1
    if n:
        _write_json(path, reviews)
    return n


def export_approved(proposals: List[Dict[str, Any]], reviews: Dict[str, Dict[str, Any]],
                    path: str = DEFAULT_APPROVED_PATH) -> int:
    """Writes the approved subset (the Enrichment Agent hand-off). Returns count."""
    approved = [p for p in proposals
                if reviews.get(p["id"], {}).get("status") == "approved"]
    _write_json(path, {"proposals": approved})
    return len(approved)


def _confidence_band(c: float) -> str:
    c = c or 0
    if c >= 0.8:
        return "high (>=0.8)"
    if c >= 0.5:
        return "medium (0.5-0.8)"
    return "low (<0.5)"


def summary(merged: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate counts for the analytics view; operates on merge() output."""
    return {
        "total": len(merged),
        "by_status": dict(Counter(p.get("status", "pending") for p in merged)),
        "by_gap_type": dict(Counter((p.get("classification") or {}).get("gap_type", "?")
                                    for p in merged)),
        "by_confidence_band": dict(Counter(_confidence_band(p.get("confidence_grade"))
                                           for p in merged)),
    }
