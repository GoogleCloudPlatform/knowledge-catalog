"""Few-shot calibration anchors for the LLM-judge rubric metrics.

For each rubric criterion (see metrics._RUBRIC) we give the judge a GRADED PAIR of
examples — a HIGH-scoring one and a LOW-scoring one — each with its score and a
one-line reason. `render_rubric_anchors` turns these into a prompt section that
`metrics.score_rubric` splices in, so the judge calibrates the FULL 0..1 scale
(what good AND bad look like), not just "good things score high".

Why a graded pair (not a single high example): a high-only anchor tends to pull
scores UP rather than calibrate — the judge learns "this is good" but not where the
floor is. Showing a contrasting low example anchors both ends of the scale.

Design notes:
  - Standalone + dependency-free ON PURPOSE so it ports verbatim to the public
    eval (agents/enrichment/eval/anchors.py).
  - To extend: add/edit entries in RUBRIC_ANCHORS keyed by the criterion name in
    metrics._RUBRIC; each value lists example tiers (high/low). Add a "mid" tier or
    more examples freely — render iterates whatever tiers are present.
  - Examples are short and domain-illustrative (not tied to one golden); the
    prompt tells the judge they may be a different domain. They calibrate the
    scale; they are not themselves graded.
"""

from __future__ import annotations

# criterion -> ordered list of graded exemplars (highest first), each:
#   {"tier": "HIGH"|"LOW", "score": float, "example": str, "why": str}
RUBRIC_ANCHORS: dict[str, list[dict]] = {
    "redundancy_index": [
        {
            "tier": "HIGH", "score": 0.95,
            "example": (
                "Orders is the system of record for placed customer orders; each "
                "row is ONE order (line-item detail lives in order_items). `status` "
                "carries revenue semantics: only Shipped/Complete count toward "
                "booked revenue, while Returned reverses it."),
            "why": (
                "Adds grain, lineage, and business/metric rules that are NOT in the "
                "schema — genuine synthesis."),
        },
        {
            "tier": "LOW", "score": 0.15,
            "example": (
                "The orders table stores order data. It has columns including "
                "order_id, user_id, status, and created_at. It is useful for "
                "analysis and reporting."),
            "why": (
                "Just restates the table name and lists columns with no business "
                "meaning, grain, or relationships — tautological boilerplate."),
        },
    ],
    "disambiguation_efficacy": [
        {
            "tier": "HIGH", "score": 0.95,
            "example": (
                "Grain: one row per order LINE (a single product within an order). "
                "Distinct from `orders` (one row per order) — join on order_id. Use "
                "this for unit-level quantity/revenue; use `orders` for order-level "
                "counts and status."),
            "why": (
                "States the exact grain AND explicitly contrasts the entry with the "
                "similar `orders` table, so the two cannot be confused."),
        },
        {
            "tier": "LOW", "score": 0.20,
            "example": (
                "This table contains important information about orders for the "
                "business. It is widely used across teams for many purposes."),
            "why": (
                "No grain and nothing distinguishing — the same sentence could "
                "describe almost any table; gives the reader no way to tell it "
                "apart from related entries."),
        },
    ],
    "absence_of_contradictions": [
        {
            "tier": "HIGH", "score": 1.0,
            "example": (
                "`orders.user_id` joins `users.id` (the same key is described in "
                "both overviews); the status enum (Shipped/Complete/Returned/"
                "Cancelled) is defined identically wherever referenced; 'active "
                "user' = a purchase in the last 90 days, used the same way in "
                "`users` and `orders`."),
            "why": (
                "Join keys, enum values, and metric definitions are stated "
                "consistently across entries — no conflicting claims."),
        },
        {
            "tier": "LOW", "score": 0.20,
            "example": (
                "The orders overview says it joins users on user_id, but its sample "
                "query joins on customer_id; `status` is described as "
                "Shipped/Returned in the overview and Open/Closed in the field "
                "notes."),
            "why": (
                "The join key and the enum values directly conflict within/across "
                "the entry — explicit contradictions a consumer would trip over."),
        },
    ],
}


# --- fact_recall (match_topics): is a golden fact CONVEYED by the entry? ---
# Graded pair for the per-fact confidence judgment (paraphrase counts; absence = 0).
FACT_RECALL_ANCHORS = [
    {
        "tier": "CONVEYED (~1.0)",
        "golden_fact": "Reorder point = average daily demand x lead time + safety stock.",
        "entry_says": (
            "\"The reorder level is the average daily usage multiplied by the lead "
            "time, plus a safety buffer.\""),
        "why": (
            "A full paraphrase — every component of the formula is present, just "
            "reworded. A fully-conveyed fact scores 1.0 (do not cap at 0.8)."),
    },
    {
        "tier": "ABSENT (~0.1)",
        "golden_fact": "Reorder point = average daily demand x lead time + safety stock.",
        "entry_says": "\"The reorder point tells you when it's time to place a new order.\"",
        "why": (
            "Names the concept but states NONE of the formula/components — the "
            "specific fact is not conveyed, so confidence is near 0."),
    },
]

# --- hallucination_free (per-claim support): is a claim SUPPORTED by the source? ---
HALLUCINATION_ANCHORS = [
    {
        "tier": "SUPPORTED",
        "claim": "Orders link customers to the fulfillment pipeline.",
        "source_has": "\"the orders table connects a buyer to the shipment process.\"",
        "why": "A paraphrase of the source supports the claim — paraphrase counts as supported.",
    },
    {
        "tier": "UNSUPPORTED",
        "claim": "Orders are automatically deleted after 90 days.",
        "source_has": "(no mention of deletion or retention anywhere in the source)",
        "why": "No chunk states this; it is a fabricated detail not grounded in the source.",
    },
]


def render_fact_anchors() -> str:
  """Prompt block: examples of a golden fact CONVEYED vs ABSENT, to anchor the
  per-fact confidence scale. "" if no anchors."""
  if not FACT_RECALL_ANCHORS:
    return ""
  lines = ["CALIBRATION EXAMPLES (per-fact confidence) — do NOT grade these:"]
  for a in FACT_RECALL_ANCHORS:
    lines.append(
        f"  {a['tier']}: golden fact \"{a['golden_fact']}\" — entry {a['entry_says']}"
        f"  WHY: {a['why']}")
  return "\n".join(lines) + "\n\n"


def render_hallucination_anchors() -> str:
  """Prompt block: examples of a claim SUPPORTED vs UNSUPPORTED by the source, to
  anchor the support judgment (paraphrase = supported; invented detail = not). ""
  if no anchors."""
  if not HALLUCINATION_ANCHORS:
    return ""
  lines = ["CALIBRATION EXAMPLES (claim support) — do NOT grade these:"]
  for a in HALLUCINATION_ANCHORS:
    lines.append(
        f"  {a['tier']}: claim \"{a['claim']}\" — source {a['source_has']}"
        f"  WHY: {a['why']}")
  return "\n".join(lines) + "\n\n"


def render_rubric_anchors(criteria_names) -> str:
  """Build a prompt section showing, per criterion, graded HIGH/LOW examples.

  Returns "" when none of `criteria_names` has anchors, so the caller can splice
  the result in unconditionally. Only criteria present in RUBRIC_ANCHORS appear.
  """
  blocks = []
  for name in criteria_names:
    tiers = RUBRIC_ANCHORS.get(name)
    if not tiers:
      continue
    lines = [f"- {name}:"]
    for ex in tiers:
      lines.append(
          f"    {ex['tier']} (~{ex['score']}): \"{ex['example']}\"  WHY: {ex['why']}"
      )
    blocks.append("\n".join(lines))
  if not blocks:
    return ""
  return (
      "CALIBRATION EXAMPLES — for each criterion, a HIGH-scoring and a LOW-scoring "
      "example with its score and reason. Use them to anchor BOTH ENDS of your "
      "0..1 scale; do NOT grade these (the documentation under review may be a "
      "different domain):\n"
      + "\n".join(blocks)
      + "\n\n"
  )
