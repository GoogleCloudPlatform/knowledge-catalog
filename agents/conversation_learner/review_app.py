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

"""Streamlit human-in-the-loop review UI for ConversationLearner proposals.

Fully local — no cloud, no agent runtime required:

    pip install -r requirements-review.txt
    streamlit run review_app.py

Reads proposal.json, persists decisions to reviews.json (keyed by stable id),
and exports the approved subset to approved_proposals.json (the hand-off to the
Enrichment Agent).
"""

import os

import pandas as pd
import streamlit as st

import review_store as rs

GAP_COLORS = {
    "LEXICAL_SYNONYM_GAP": "#6366f1",
    "BUSINESS_LOGIC_GAP": "#d97706",
    "STRUCTURAL_ROUTING_GAP": "#dc2626",
    "UNCATALOGED_ASSET_DISCOVERY": "#0891b2",
    "VALIDATED_CONTEXT": "#16a34a",
}
STATUS_BADGE = {"pending": "⏳ pending", "approved": "✅ approved", "rejected": "❌ rejected"}
MAX_CARDS = 50

st.set_page_config(page_title="ConversationLearner — Proposal Review",
                   page_icon="🧠", layout="wide")


@st.cache_data(show_spinner=False)
def _load_proposals_cached(path, _mtime):
    # _mtime is part of the cache key so the file is re-read when it changes.
    return rs.load_proposals(path)


def _badge(text, color):
    return (f"<span style='background:{color};color:white;padding:2px 8px;"
            f"border-radius:6px;font-size:0.75rem;font-weight:600'>{text}</span>")


def _gap(p):
    return (p.get("classification") or {}).get("gap_type", "?")


def _signal(p):
    return (p.get("classification") or {}).get("detection_signal", "?")


def _asset_name(p):
    return (p.get("target_asset") or {}).get("name") or ""


def _conf(p):
    return p.get("confidence_grade") or 0.0


# --- load ---
proposals_path = rs.DEFAULT_PROPOSALS_PATH
if not os.path.exists(proposals_path):
    st.error(f"No proposals found at {proposals_path}. Run the agent first "
             f"(generate_learnings) to produce proposal.json.")
    st.stop()

proposals = _load_proposals_cached(proposals_path, os.path.getmtime(proposals_path))
reviews = rs.load_reviews()
merged = rs.merge(proposals, reviews)
stats = rs.summary(merged)

# --- header + metrics ---
st.title("🧠 ConversationLearner — Proposal Review")
st.caption("Review enrichment proposals, then export the approved set for the Enrichment Agent.")
m = st.columns(4)
m[0].metric("Total", stats["total"])
m[1].metric("⏳ Pending", stats["by_status"].get("pending", 0))
m[2].metric("✅ Approved", stats["by_status"].get("approved", 0))
m[3].metric("❌ Rejected", stats["by_status"].get("rejected", 0))

# --- sidebar: filters + bulk + export ---
sb = st.sidebar
sb.header("Filters")
gap_opts = sorted({_gap(p) for p in merged})
sig_opts = sorted({_signal(p) for p in merged})
f_status = sb.multiselect("Status", list(rs.STATUSES), default=list(rs.STATUSES))
f_gap = sb.multiselect("Gap type", gap_opts, default=gap_opts)
f_sig = sb.multiselect("Detection signal", sig_opts, default=sig_opts)
f_conf = sb.slider("Min confidence", 0.0, 1.0, 0.0, 0.05)
f_query = sb.text_input("🔎 Asset contains")

sb.divider()
sb.subheader("Bulk action")
bulk_thresh = sb.slider("Approve pending with confidence ≥", 0.0, 1.0, 0.9, 0.05)
if sb.button("Apply bulk approve", use_container_width=True):
    n = rs.bulk_approve(proposals, bulk_thresh)
    sb.success(f"Approved {n} pending proposal(s).")
    st.rerun()

sb.divider()
if sb.button("⬇ Export approved", type="primary", use_container_width=True):
    n = rs.export_approved(proposals, reviews)
    sb.success(f"Exported {n} approved → {os.path.basename(rs.DEFAULT_APPROVED_PATH)}")


def _visible(p):
    return (p["status"] in f_status
            and _gap(p) in f_gap
            and _signal(p) in f_sig
            and _conf(p) >= f_conf
            and f_query.lower() in _asset_name(p).lower())


filtered = [p for p in merged if _visible(p)]

tab_review, tab_analytics = st.tabs(["Review", "Analytics"])

with tab_review:
    st.caption(f"{len(filtered)} of {len(merged)} proposals match filters")
    for p in filtered[:MAX_CARDS]:
        gap = _gap(p)
        pe = p.get("proposed_enrichment") or {}
        ev = p.get("evidence") or {}
        with st.container(border=True):
            head = st.columns([4, 1])
            with head[0]:
                occ = p.get("occurrence_count") or 1
                st.markdown(
                    _badge(gap, GAP_COLORS.get(gap, "#555")) + " "
                    + _badge(_signal(p), "#374151")
                    + (f" {_badge(f'recurring ×{occ}', '#7c3aed')}" if occ > 1 else "")
                    + f" &nbsp; <b>{(p.get('target_asset') or {}).get('type', '?')}</b> "
                    + f"· <code>{_asset_name(p)}</code>",
                    unsafe_allow_html=True,
                )
                st.markdown(f"**Fix →** `{pe.get('action', '?')}`: {pe.get('value', '')}")
                if p.get("current_context_flaw"):
                    st.caption(f"Flaw: {p['current_context_flaw']}")
            with head[1]:
                st.metric("confidence", f"{_conf(p):.2f}")
                st.progress(min(max(_conf(p), 0.0), 1.0))
            with st.expander(f"Evidence ({occ} conversation{'s' if occ != 1 else ''})"):
                supporting = p.get("supporting_evidence") or []
                if supporting:
                    for s in supporting:
                        cid = s.get("conversation_id")
                        if s.get("reasoning"):
                            st.write((f"**{cid}** — " if cid else "") + s["reasoning"])
                        if s.get("trajectory_quote"):
                            st.code(s["trajectory_quote"])
                else:
                    st.write(ev.get("reasoning", ""))
                    if ev.get("trajectory_quote"):
                        st.code(ev["trajectory_quote"])
            with st.expander("Enrichment instruction"):
                st.write(p.get("enrichment_agent_instruction", ""))
                golden_sql = (p.get("eval_candidate") or {}).get("golden_sql")
                if golden_sql:
                    st.code(golden_sql, language="sql")
            act = st.columns([1, 1, 4])
            if act[0].button("✅ Approve", key=f"a_{p['id']}", use_container_width=True):
                rs.save_review(p["id"], "approved")
                st.rerun()
            if act[1].button("❌ Reject", key=f"r_{p['id']}", use_container_width=True):
                rs.save_review(p["id"], "rejected")
                st.rerun()
            act[2].markdown(f"status: **{STATUS_BADGE.get(p['status'], p['status'])}**"
                            + (f" — _{p['review_note']}_" if p.get("review_note") else ""))
    if len(filtered) > MAX_CARDS:
        st.info(f"Showing the first {MAX_CARDS} of {len(filtered)}. "
                f"Refine filters or bulk-approve to narrow the queue.")

with tab_analytics:
    st.subheader("By status")
    st.bar_chart(pd.Series(stats["by_status"], name="count"))
    st.subheader("By gap type")
    st.bar_chart(pd.Series(stats["by_gap_type"], name="count"))
    st.subheader("By confidence band")
    st.bar_chart(pd.Series(stats["by_confidence_band"], name="count"))
