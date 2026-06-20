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

"""Deterministic, run-stable identity and id for enrichment proposals.

Pure standard-library (no GCP / ADK dependencies) so this single definition can
be shared by the agent (agent.py) and the standalone local review UI
(review_store.py / review_app.py) without the UI having to import the agent's
heavy runtime. Keeping one copy means agent-generated ids and UI-computed ids
always match.
"""

import hashlib
import json
from typing import Any, Dict, Optional, Tuple


def _canonical_asset_name(name: Optional[str], asset_type: str = "") -> str:
    """Canonicalizes a BigQuery-style asset path so the same asset normalizes the
    same whether or not the LLM included the project prefix.

    References look like ``project.dataset.table.column`` (or any suffix). A
    leading project component is dropped when detectable: a project id may contain
    hyphens (BigQuery dataset/table/column identifiers may not), and a four-part
    path is always ``project.dataset.table.column``. Glossary terms aren't paths,
    so only their case/whitespace is normalized.

    Residual limit: a hyphen-free project in an ambiguous three-part path
    (``project.dataset.table`` vs ``dataset.table.column``) can't be told apart
    and is left intact.
    """
    name = (name or "").strip().lower()
    if not name or asset_type == "GLOSSARY_TERM":
        return name
    parts = name.split(".")
    if len(parts) >= 2 and ("-" in parts[0] or len(parts) == 4):
        parts = parts[1:]  # drop the leading project component
    return ".".join(parts)


def _proposal_identity(proposal: Dict[str, Any]) -> Tuple:
    """The fields that define a unique proposal — used for BOTH cross-conversation
    dedup and the optional proposal id, so the two never disagree.

    Identity is asset type + canonical name + gap_type. It deliberately excludes
    the proposed value (volatile LLM-generated text that varies run to run). The
    asset name is canonicalized (see _canonical_asset_name) so the project prefix
    being present or absent doesn't split one asset into two. A blank asset name
    (e.g. uncataloged-asset discoveries) falls back to a hash of the enrichment
    instruction so genuinely distinct finds are not merged.
    """
    asset = proposal.get("target_asset") or {}
    atype = asset.get("type", "")
    name = _canonical_asset_name(asset.get("name"), atype)
    gap = (proposal.get("classification") or {}).get("gap_type", "")
    if name:
        return (atype, name, gap)
    instr = proposal.get("enrichment_agent_instruction") or json.dumps(
        proposal.get("proposed_enrichment", ""), sort_keys=True
    )
    return (atype, gap, hashlib.sha1(instr.encode()).hexdigest()[:12])


def _proposal_id(proposal: Dict[str, Any]) -> str:
    """Deterministic, run-stable id derived from a proposal's identity.

    The same gap on the same asset yields the same id across runs (useful for
    tracking, linking, and idempotent downstream processing). Uses hashlib, NOT
    the builtin hash() (which is per-process salted and would not be reproducible).
    """
    canonical = "|".join(str(part) for part in _proposal_identity(proposal))
    return "prop_" + hashlib.sha256(canonical.encode()).hexdigest()[:12]
