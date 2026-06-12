"""Metrics for scoring emitted Metadata-as-Code against a case's golden.

Deterministic (no model): structural/contract validity, input-conditioned
trajectory, perf guardrails, business-term presence.
LLM-as-judge (pluggable `judge`): topic-flavor matching (concept recall/precision
+ fact coverage with confidence), rubric dimensions, hallucination/groundedness.

`judge` is any Callable[[str], str] returning model text (expected JSON). Tests
inject a stub so deterministic metrics + wiring run without tokens.
"""

from __future__ import annotations

import concurrent.futures
import dataclasses
import json
import os
import re
from typing import Callable

import yaml

Judge = Callable[[str], str]


def _clip(s, n: int) -> str:
  """Truncate to <= n chars at a WORD boundary (+ ellipsis) so rationales never
  cut mid-word (e.g. '...replenishment is delay'). Generous default caps."""
  s = str(s or "").strip()
  if len(s) <= n:
    return s
  cut = s[:n].rsplit(" ", 1)[0].rstrip(" ,;:—-")
  return (cut or s[:n]) + "…"


@dataclasses.dataclass
class MetricResult:
  name: str
  score: float
  passed: bool
  detail: str = ""          # rationale: WHY this score
  insights: str = ""        # actionable: HOW to improve (LLM-judge metrics)
  extra: dict = dataclasses.field(default_factory=dict)


def parse_json(text: str):
  """Best-effort JSON extraction from an LLM response."""
  t = (text or "").strip()
  m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
  if m:
    t = m.group(1).strip()
  m = re.search(r"(\{.*\}|\[.*\])", t, re.S)
  if m:
    t = m.group(1)
  try:
    return json.loads(t)
  except (ValueError, json.JSONDecodeError):
    return None


def parse_json_obj(text: str) -> dict:
  """Like parse_json but ALWAYS returns a dict. The judge sometimes emits a JSON
  array (or non-object); callers that then do `.get(...)` would crash with
  "'list' object has no attribute 'get'". This guarantees a dict so every
  object-shaped judge call site is safe."""
  res = parse_json(text)
  return res if isinstance(res, dict) else {}


# ============================ deterministic ============================

_ENTRY_TYPE = {"doc": "dataplex-types.global.generic",
               "table": "dataplex-types.global.bigquery-table"}


def check_structural(artifacts: dict, mode: str) -> MetricResult:
  """mdcode contract: entries parse, required fields, correct type, overview present."""
  yamls = {p: t for p, t in artifacts.get("yaml", {}).items()
           if not p.endswith("catalog.yaml")}
  overviews = artifacts.get("overview_md", {})
  if not yamls:
    return MetricResult("structural_validity", 0.0, False, "no entry YAML emitted")
  want_type = _ENTRY_TYPE.get(mode)
  problems, ok = [], 0
  for path, text in yamls.items():
    name = path.rsplit("/", 1)[-1]
    if len(re.findall(r"^---\s*$", text, re.M)) >= 2:
      problems.append(f"{name} contains multiple YAML documents (there should be "
                      "exactly one entry per file)")
      continue
    try:
      doc = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
      first = str(e).strip().splitlines()[0]
      problems.append(f"{name} isn't valid YAML ({first})")
      continue
    if not (doc.get("name") or doc.get("id")):
      problems.append(f"{name} is missing the required 'name'/'id' field"); continue
    if not doc.get("type"):
      problems.append(f"{name} is missing the required 'type' field"); continue
    if want_type and doc.get("type") != want_type:
      problems.append(f"{name} has entry type '{doc.get('type')}', but a "
                      f"{mode}-mode entry must be '{want_type}'"); continue
    if not isinstance(doc.get("resource"), dict):
      problems.append(f"{name} has a missing or malformed 'resource' block"); continue
    ok += 1
  if not overviews:
    problems.append("the agent didn't write any overview (.overview.md) files")
  # Markdown checks (folded in from the former markdown_structure_score). Track the
  # set of bad overview files so they count against the SCORE, not just pass/fail.
  bad_ov: set[str] = set()
  # 1) every overview must have at least one Markdown header.
  unstructured = [p for p, t in overviews.items()
                  if not re.search(r"^#{1,6}\s+\S", t or "", re.M)]
  if unstructured:
    bad_ov.update(unstructured)
    problems.append("overview(s) lack Markdown headers/sections: "
                    + ", ".join(os.path.basename(p) for p in unstructured))
  # 2) no leading YAML frontmatter -- empty ('--- {} ---') is noise; a populated one
  #    (e.g. 'title:') isn't part of the `overview` aspect and can break `kcmd push`.
  bad_fm = []
  for p, t in overviews.items():
    fm = re.match(r"\s*---\s*\n(.*?)\n---", t or "", re.S)
    if fm:
      body = fm.group(1).strip()
      kind = "empty '--- {} ---'" if body in ("", "{}", "{ }") else "stray frontmatter (e.g. title:)"
      bad_ov.add(p)
      bad_fm.append(f"{os.path.basename(p)} [{kind}]")
  if bad_fm:
    problems.append("overview(s) begin with a YAML frontmatter block — overviews "
                    "should be clean Markdown, not frontmatter: " + ", ".join(bad_fm))
  # 3) no unclosed code fences.
  unclosed = [p for p, t in overviews.items() if (t or "").count("```") % 2]
  if unclosed:
    bad_ov.update(unclosed)
    problems.append("overview(s) have an unclosed code fence: "
                    + ", ".join(os.path.basename(p) for p in unclosed))
  # Score = fraction of all generated files (entry YAMLs + overview .md) that are
  # clean. So a markdown problem lowers the score too (no more "score 1.0 but FAIL").
  total = len(yamls) + len(overviews)
  clean = ok + (len(overviews) - len(bad_ov))
  score = (clean / total) if total else 0.0
  passed = not problems and bool(overviews)
  detail = ("Some generated files aren't valid Metadata-as-Code: "
            + "; ".join(problems)) if problems else (
      f"All {ok} generated " + ("entry is" if ok == 1 else "entries are") +
      " valid Metadata-as-Code (YAML parses, required fields present, entry type "
      "matches the mode, an overview was written, and overviews are clean Markdown "
      "with headers and no stray frontmatter).")
  return MetricResult("structural_validity", round(score, 3), passed, detail,
                      extra={"entries_ok": ok, "entries_total": len(yamls),
                             "overviews_ok": len(overviews) - len(bad_ov),
                             "overviews_total": len(overviews)})


def check_entry_grounding(artifacts: dict) -> MetricResult:
  """Table-mode precision guard: every generated overview entry must correspond to
  a REAL pulled dataset table (its entry YAML, which is the source of truth in
  table mode). Catches invented/spurious entries generated 'on top' of the
  dataset. Deterministic -- no judge."""
  norm = lambda p: re.sub(r"[-_]", "", os.path.basename(p)
                          .replace(".overview.md", "").replace(".yaml", "").lower())
  refs = {norm(p) for p in artifacts.get("yaml", {}) if not p.endswith("catalog.yaml")}
  produced = {}
  for p in artifacts.get("overview_md", {}):
    produced[norm(p)] = os.path.basename(p).replace(".overview.md", "")
  if not produced:
    return MetricResult("entry_grounding", 1.0, True, "No entries produced to check.")
  if not refs:
    return MetricResult("entry_grounding", 1.0, True,
                        "No pulled table references available to check against.")
  spurious = sorted(orig for n, orig in produced.items() if n not in refs)
  score = (len(produced) - len(spurious)) / len(produced)
  ok = not spurious
  detail = (f"All {len(produced)} generated entries correspond to a real dataset "
            "table (no invented entries)." if ok else
            f"{len(spurious)} generated entr{'y' if len(spurious) == 1 else 'ies'} "
            f"not backed by any dataset table (invented on top): {', '.join(spurious)}.")
  return MetricResult("entry_grounding", round(score, 3), ok, detail,
                      extra={"spurious": spurious})


def check_expected_headings(artifacts: dict, expected: list[str]) -> MetricResult:
  """Golden-driven section coverage (replaces the judge 'enrichment_diversity').

  Each golden case can declare the sections it expects the enrichment to contain
  (e.g. 'Lineage', 'Sample Queries'). Freshness/SLA and Grain are intentionally
  NOT part of this metric. We check, by case-insensitive heading/text match, how
  many are present across the overviews. Concrete and deterministic -- no judge,
  and grounded in what we actually want."""
  if not expected:
    return MetricResult("enrichment_diversity", 1.0, True,
                        "No expected sections declared for this case.")
  overview_blob = "\n".join(artifacts.get("overview_md", {}).values()).lower()
  queries_blob = "\n".join(artifacts.get("queries_md", {}).values()).lower()
  blob = (overview_blob + "\n" + queries_blob).strip()
  # The agent now emits sample queries in a separate `<table>.queries.md` sidecar
  # (a YAML `queries:` list) instead of a "## Sample Queries" overview section, so
  # the literal heading text isn't in either blob -- detect real query content.
  has_queries = bool(queries_blob.strip()) and (
      "sql:" in queries_blob or "select " in queries_blob
      or "queries:" in queries_blob)
  if not blob:
    return MetricResult("enrichment_diversity", 0.0, False,
                        "No overview produced, so none of the expected sections "
                        f"({', '.join(expected)}) are present.")
  present, missing = [], []
  for h in expected:
    # match any alias separated by '/' or '&' (e.g. "Freshness / SLA")
    aliases = [a.strip().lower() for a in re.split(r"[/&]", h) if a.strip()]
    # A "Sample/Common/Example Queries" section is satisfied by a populated
    # queries.md sidecar even though its YAML body has no heading text.
    is_query_heading = any("quer" in a for a in aliases)
    matched = any(a and a in blob for a in aliases) or (
        is_query_heading and has_queries)
    (present if matched else missing).append(h)
  score = len(present) / len(expected)
  detail = (f"Covers {len(present)} of {len(expected)} expected sections"
            + (f"; missing: {', '.join(missing)}." if missing else "."))
  return MetricResult("enrichment_diversity", score, score >= 0.5, detail,
                      extra={"present": present, "missing": missing})


_TRAJECTORY_MARKERS = {
    "folder_list": [r"Listing Drive folder", r"Found \d+ file"],
    "drive_fetch": [r"Fetching", r"summariz"],
    # Table-mode BigQuery dataset discovery ONLY. NOTE: doc mode also runs
    # `kcmd init --entry-group` + `kcmd pull`, so bare "kcmd"/"pull" must NOT be
    # markers here or doc mode falsely trips must_not_call:[dataset_pull].
    "dataset_pull": [r"bigquery-dataset", r"bq-dataset", r"Discovered \d+ table",
                     r"--dataset\b"],
    "github_fetch": [r"github"],
    "sharepoint_fetch": [r"sharepoint"],
}


def fired_tools(stdout: str) -> set[str]:
  return {tool for tool, pats in _TRAJECTORY_MARKERS.items()
          if any(re.search(p, stdout or "", re.I) for p in pats)}


_TOOL_PHRASE = {
    "folder_list": "list the Drive folder",
    "drive_fetch": "fetch the document(s)",
    "dataset_pull": "pull/discover the BigQuery dataset",
    "github_fetch": "fetch from GitHub",
    "sharepoint_fetch": "fetch from SharePoint",
}


def check_trajectory(stdout: str, golden: dict) -> MetricResult:
  """Input-conditioned tool use: must_call present, must_not_call absent."""
  fired = fired_tools(stdout)
  missing = sorted(set(golden.get("must_call", [])) - fired)
  violated = sorted(set(golden.get("must_not_call", [])) & fired)
  passed = not missing and not violated
  phr = lambda ts: ", ".join(_TOOL_PHRASE.get(t, t) for t in ts)
  if passed:
    detail = ("The agent used the expected tools for its inputs ("
              + (phr(sorted(fired)) or "no external sources") +
              ") and didn't touch any source it wasn't given.")
  else:
    parts = []
    if missing:
      parts.append("based on its inputs it should have " + phr(missing)
                   + ", but it didn't")
    if violated:
      parts.append("it ran " + phr(violated)
                   + " even though that input wasn't provided")
    detail = "The agent's tool use didn't match its inputs: " + "; ".join(parts) + "."
  return MetricResult("trajectory", 1.0 if passed else 0.0, passed, detail,
                      extra={"fired": sorted(fired)})


def check_perf(latency_s: float, artifacts: dict, budget: dict,
               tokens: dict | None = None) -> MetricResult:
  """REPORT-ONLY (does NOT gate). Surfaces latency, token usage, and output size
  for visibility. No pass/fail threshold is enforced here -- this metric is
  reported, not gated."""
  tok = tokens or {}
  tin, tout = tok.get("input", 0) or 0, tok.get("output", 0) or 0
  ttot = tok.get("total", (tin + tout))
  overviews = artifacts.get("overview_md", {})
  longest = max((len(t) for t in overviews.values()), default=0)
  tok_txt = (f" Used {ttot:,} tokens ({tin:,} in / {tout:,} out)." if ttot else "")
  lat_txt = (f"Completed in {latency_s:.0f}s." if latency_s and latency_s > 0
             else "Latency not recorded (re-run the agent to capture it).")
  detail = (lat_txt + tok_txt +
            (f" Longest overview {longest:,} chars." if longest else "") +
            " (Report-only — not gated.)")
  # Always passes: report-only so it never fails the case gate.
  return MetricResult("perf", 1.0, True, detail,
                      extra={"tokens": {"input": tin, "output": tout, "total": ttot}})


def check_business_terms(artifacts: dict, terms: list[str],
                         judge: Judge | None = None) -> MetricResult:
  """Are the expected business terms PRESENT? Loose / flavor matching: a term
  counts if its meaning appears under ANY synonym / paraphrase / abbreviation
  (a 'flavor' of it) -- exact wording is NOT required. Uses the LLM judge when
  available; falls back to a case-insensitive substring check otherwise."""
  if not terms:
    return MetricResult("business_terms_presence", 1.0, True, "none expected")
  text = ("\n".join(artifacts.get("overview_md", {}).values()) + "\n" +
          "\n".join(artifacts.get("yaml", {}).values()))
  if judge is not None:
    prompt = ("Which EXPECTED TERMS are present in the documentation? Count a term "
              "as present if its meaning appears under ANY synonym / paraphrase / "
              "abbreviation (a 'flavor' of it) -- exact wording is NOT required "
              "(e.g. 'BOM' counts for 'Bill of Materials').\n"
              f"EXPECTED TERMS: {terms}\n\nDOCUMENTATION:\n{text[:50000]}\n\n"
              'Return STRICT JSON: {"present":[<terms from the list present in any flavor>],'
              '"rationale":"<one sentence>"}')
    res = parse_json_obj(judge(prompt))
    present = [t for t in terms if t in (res.get("present") or [])]
    missing = [t for t in terms if t not in present]
    base = (res.get("rationale", "").strip()
            or f"Found {len(present)} of {len(terms)} expected business terms "
               "(matched by meaning, not exact wording).")
    return MetricResult(
        "business_terms_presence", len(present) / len(terms), not missing,
        base + (f" Missing: {', '.join(missing)}." if missing else ""))
  low = text.lower()
  found = [t for t in terms if t.lower() in low]
  missing = [t for t in terms if t not in found]
  return MetricResult(
      "business_terms_presence", len(found) / len(terms), not missing,
      f"Found {len(found)} of {len(terms)} expected business terms in the output "
      "(exact-text match — turn on the LLM judge for synonym/flavor matching)."
      + (f" Not found: {', '.join(missing)}." if missing else ""))


def check_context_preservation(artifacts: dict, prebaked_facts: list[str],
                               judge: Judge | None = None) -> MetricResult:
  """Merge/update path: when enriching an entry that ALREADY has pre-baked
  context, that context must be PRESERVED (not clobbered) and then augmented with
  the new folder facts.

  Each pre-baked fact must still be present (by meaning) in the post-enrichment
  overview. Loose flavor matching like check_business_terms: LLM judge when
  available, case-insensitive substring fallback otherwise. Today the agent always
  scaffolds a CLEAN output dir (doc_mode.py) and regenerates from scratch -- there
  is no merge-into-existing path -- so this is EXPECTED to fail until that
  capability lands (a known gap)."""
  if not prebaked_facts:
    return MetricResult("context_preservation", 1.0, True,
                        "No pre-baked context to preserve for this case.")
  text = "\n".join(artifacts.get("overview_md", {}).values())
  if not text.strip():
    return MetricResult(
        "context_preservation", 0.0, False,
        "The agent produced no overview, so any pre-existing (pre-baked) context "
        "on the entry would have been lost rather than preserved.")
  if judge is not None:
    prompt = ("An entry had PRE-BAKED CONTEXT before enrichment. Which of these "
              "pre-baked facts are STILL present (by meaning -- synonym/paraphrase "
              "is fine) in the post-enrichment documentation? A fact counts as "
              "preserved only if its substance survived.\n"
              f"PRE-BAKED FACTS: {prebaked_facts}\n\nPOST-ENRICHMENT DOCUMENTATION:\n"
              f"{text[:50000]}\n\nReturn STRICT JSON: "
              '{"preserved":[<facts still present>],"rationale":"<one sentence>"}')
    res = parse_json_obj(judge(prompt))
    kept = [f for f in prebaked_facts if f in (res.get("preserved") or [])]
    lost = [f for f in prebaked_facts if f not in kept]
    base = (res.get("rationale", "").strip()
            or f"{len(kept)} of {len(prebaked_facts)} pre-baked facts were "
               "preserved after enrichment.")
    return MetricResult(
        "context_preservation", len(kept) / len(prebaked_facts), not lost,
        base + (f" Lost: {', '.join(lost)}." if lost else ""))
  low = text.lower()
  kept = [f for f in prebaked_facts if f.lower() in low]
  lost = [f for f in prebaked_facts if f not in kept]
  return MetricResult(
      "context_preservation", len(kept) / len(prebaked_facts), not lost,
      f"{len(kept)} of {len(prebaked_facts)} pre-baked facts survived enrichment "
      "(exact-text match — turn on the LLM judge for meaning-level matching)."
      + (f" Lost: {', '.join(lost)}." if lost else ""))


# ============================ LLM-as-judge ============================

def _name_tokens(s: str) -> set:
  """Lowercase alphanumeric tokens of a name/id (kebab/snake/space agnostic)."""
  return set(re.findall(r"[a-z0-9]+", str(s).lower()))


def _deterministic_entry_match(topic: dict, produced_basenames: list[str]) -> str:
  """Deterministic backstop for concept matching (no LLM).

  Returns the produced entry whose id literally contains ALL tokens of the
  topic's canonical name (or a declared alias), else "". This rescues the
  obvious cases the matching judge flakily misses -- e.g. an entry `lead-time`
  for canonical "Lead Time", or `sku-management` for "SKU".

  Deliberately uses ONLY canonical + explicit `aliases`, NOT the broader
  `flavor_hints`: hints like "Knowledge Catalog" are generic enough to wrongly
  swallow unrelated entries (e.g. a `knowledge-catalog-discovery-agent`), so
  they stay judge-only. A token-SUBSET test (not substring) avoids partial-word
  false matches.
  """
  needle_sets = []
  for n in [topic.get("canonical", "")] + list(topic.get("aliases") or []):
    ts = _name_tokens(n)
    if ts:
      needle_sets.append(ts)
  for base in produced_basenames:
    ent = _name_tokens(re.sub(r"\.(overview\.md|md|yaml)$", "", str(base)))
    for ns in needle_sets:
      if ns <= ent:
        return base
  return ""


def match_topics(artifacts: dict, expected_topics: list[dict], judge: Judge,
                 confidence_threshold: float = 0.7) -> dict:
  """Semantic topic-flavor matching (doc mode): recall/precision/fact coverage."""
  blob = "\n\n".join(f"### {p}\n{t}"
                     for p, t in artifacts.get("overview_md", {}).items())
  n_produced = len(artifacts.get("overview_md", {}))
  if n_produced == 0 or not blob.strip():
    # No entries produced -> nothing to match; don't waste judge calls.
    return {"concept_recall": 0.0, "concept_precision": 0.0, "fact_coverage": 0.0,
            "per_topic": [{"topic": t["canonical"], "confidence": 0.0,
                           "matched": False, "fact_coverage": 0.0,
                           "matched_entry_id": "",
                           "rationale": "no entries produced by the agent"}
                          for t in expected_topics]}
  # SINGLE judge call grades ALL expected topics at once (was one call per topic).
  spec = [{"canonical": t["canonical"],
           "flavor_hints": t.get("flavor_hints", []),
           "golden_facts": t.get("golden_facts", [])}
          for t in expected_topics]
  prompt = (
      "Grade a generated knowledge base against EACH expected topic. For every "
      "topic, find the single best-matching generated entry BY MEANING/CONTENT. "
      "Match on what the entry is ABOUT -- IGNORE differences in the entry id / "
      "file name formatting (e.g. 'lead-time' vs 'lead_time' vs 'Lead Time' are the "
      "same entry). For EACH golden fact, judge SEMANTICALLY whether the entry "
      "conveys it -- paraphrases and reworded statements fully count; do NOT require "
      "exact wording -- and give a CONFIDENCE 0..1 that the fact is present. Use "
      "the FULL range and anchor on these points: 1.0 = fully conveyed (stated "
      "outright OR clearly paraphrased/inferable) -- a fully-conveyed fact MUST "
      "score 1.0, do NOT cap it at 0.8; 0.7-0.9 = conveyed but a minor "
      "qualifier/value is missing; ~0.5 = only partially stated; 0.0 = absent. "
      "Return one confidence per golden fact, IN THE SAME ORDER as listed.\n\n"
      "ALSO return a parallel `fact_details` array (same order, one per golden "
      "fact). For a fact that is fully or near-fully present (confidence >= 0.8) "
      "use null -- and do NOT lower a fact's confidence merely to justify adding "
      "a detail. For a fact that is only PARTIALLY present or absent "
      "(confidence < 0.8), return an object: "
      '{"covered":"<the part of the fact that IS conveyed, or \\"\\" if none>",'
      '"quote":"<the exact sentence/phrase from the generated entry that conveys '
      'the covered part, verbatim, or \\"\\" if none>",'
      '"missing":"<the specific part of the fact that is NOT conveyed>"}. '
      "Be concrete: name the sub-claim, value, qualifier, or relationship that is "
      "missing -- not just 'partially covered'.\n\n"
      f"EXPECTED TOPICS:\n{json.dumps(spec, indent=2)}\n\n"
      f"GENERATED ENTRIES:\n{blob[:60000]}\n\n"
      'Return STRICT JSON: {"topics":[{"canonical":"<topic>","matched_entry_id":'
      '"<id or empty>","confidence":<0..1>,"fact_confidences":[<one 0..1 per golden '
      'fact, same order>],"fact_details":[<null or {covered,quote,missing}, same '
      'order>],"rationale":"<one sentence>"}, ...]} one object per topic.')
  res = parse_json_obj(judge(prompt))
  by_canon = {r.get("canonical"): r
              for r in (res.get("topics") or []) if isinstance(r, dict)}
  produced_basenames = [os.path.basename(p)
                        for p in artifacts.get("overview_md", {}).keys()]
  per_topic, matched_entries, fact_cov = [], set(), []
  for topic in expected_topics:
    r = by_canon.get(topic["canonical"]) or {}
    conf = float(r.get("confidence", 0) or 0)
    facts = topic.get("golden_facts", []) or []
    # Per-fact semantic confidence (0..1), averaged -- NOT exact-string matching.
    fconf = r.get("fact_confidences")
    if not isinstance(fconf, list):
      # Back-compat: derive from a covered_facts list if that's what came back.
      cov_set = r.get("covered_facts", []) or []
      fconf = [1.0 if f in cov_set else 0.0 for f in facts]
    confs = []
    for i, f in enumerate(facts):
      try:
        confs.append(max(0.0, min(1.0, float(fconf[i]))))
      except (IndexError, TypeError, ValueError):
        confs.append(0.0)
    cov = (sum(confs) / len(confs)) if confs else 1.0
    # Per-fact covered/missing breakdown (with a supporting quote) from the judge.
    fdetails = r.get("fact_details")
    if not isinstance(fdetails, list):
      fdetails = []
    def _detail(i):
      d = fdetails[i] if i < len(fdetails) and isinstance(fdetails[i], dict) else {}
      return {"covered": str(d.get("covered", "") or "").strip(),
              "quote": str(d.get("quote", "") or "").strip(),
              "missing": str(d.get("missing", "") or "").strip()}
    # Categorize by semantic-presence confidence: clearly absent vs only partial.
    # partial_facts carries the breakdown so the report can say which part of the
    # fact is covered (and by which statement) and which part is not.
    missing_facts = [f for f, sc in zip(facts, confs) if sc < 0.5]
    partial_facts = [{"fact": f, **_detail(i)}
                     for i, (f, sc) in enumerate(zip(facts, confs))
                     if 0.5 <= sc < 0.8]
    judge_matched = conf >= confidence_threshold and bool(r.get("matched_entry_id"))
    # Deterministic backstop: rescue topics the judge flakily marked missing when
    # a produced entry id literally carries the canonical/alias name. Union with
    # the judge so recall/precision can only go UP, never down.
    det_id = "" if judge_matched else _deterministic_entry_match(topic, produced_basenames)
    matched = judge_matched or bool(det_id)
    match_id = r.get("matched_entry_id", "") if judge_matched else det_id
    if matched:
      matched_entries.add(match_id)
      # Only trust the judge's per-fact confidences when the JUDGE found the
      # entry; on a deterministic rescue its fact scores are ~0 (it thought the
      # topic was absent) and would wrongly tank fact_recall, so skip them.
      if judge_matched:
        fact_cov.append(cov)
    rationale = r.get("rationale", "")
    if det_id and not judge_matched:
      rationale = (f"matched deterministically by name to '{det_id}' "
                   f"(judge missed it). " + (rationale or "")).strip()
    per_topic.append({"topic": topic["canonical"],
                      "confidence": 1.0 if det_id and not judge_matched else conf,
                      "matched": matched, "fact_coverage": cov,
                      "matched_entry_id": match_id,
                      "matched_by": ("judge" if judge_matched
                                     else ("name" if det_id else "")),
                      "missing_facts": missing_facts,
                      "partial_facts": partial_facts,
                      "rationale": rationale})
  n_topics = len(expected_topics) or 1
  recall = sum(1 for t in per_topic if t["matched"]) / n_topics
  precision = (len(matched_entries) / n_produced) if n_produced else 0.0
  mean_cov = (sum(fact_cov) / len(fact_cov)) if fact_cov else 0.0
  # Which produced entries are EXTRA (didn't match any expected topic) -- so the
  # rationale can name e.g. "also produced a 'UPC/GTIN' entry that wasn't expected".
  _norm = lambda s: os.path.basename(str(s)).replace(".overview.md", "").replace(".md", "").strip().lower()
  matched_norm = {_norm(x) for x in matched_entries}
  produced = list(artifacts.get("overview_md", {}).keys())
  extra = [os.path.basename(p) for p in produced if _norm(p) not in matched_norm]
  return {"concept_recall": recall, "concept_precision": precision,
          "fact_coverage": mean_cov, "per_topic": per_topic,
          "extra_entries": extra,
          "produced_entries": [os.path.basename(p) for p in produced]}


# Rubric dimensions (Jialu's web-app rubric + strategy-doc dims). Each is judged
# 0..1 against the generated mdcode and (where relevant) the source context.
# NOTE (per doc comments): markdown_structure_score was folded into the
# deterministic structural_validity, and enrichment_diversity became the
# golden-driven check_expected_headings -- so neither is judged here anymore.
_RUBRIC = {
    "redundancy_index":
        "Does the overview add novel semantic context beyond echoing column "
        "names/schema? 1=rich synthesis, 0=tautological restatement.",
    "disambiguation_efficacy":
        "Is the enrichment sufficient to distinguish this entry from "
        "similar/overlapping ones (grain + purpose explicit)? 1=clearly unique.",
    "absence_of_contradictions":
        "Are there contradictions within or across the generated entries "
        "(join keys, enums, metric defs, freshness)? 1=none, 0=explicit conflict.",
}


# Dedicated business-term Metadata-as-Code files (.md/.yaml per term) are NOT
# emitted by the agent yet, so check_business_terms_validity is EXPECTED to fail
# today (terms may still appear inline in the overview -> check_business_terms).
# Reported but not gated, so it doesn't break a regression suite. When the agent
# gains per-term file output, it passes with no code change.
_TERM_FILE_HINTS = ("glossary", "business-term", "business_term", "/terms/", ".term.")


def check_business_terms_validity(artifacts: dict, expected_terms: list[str],
                                  judge: Judge | None = None) -> MetricResult:
  """Each expected term must have its OWN standalone MaC file AND that file must
  accurately define the term.

  File *existence* is deterministic; *content* validity is LLM-judged. Today the
  agent emits no per-term files, so this fails at the existence gate (a known
  gap). Once per-term files are
  emitted, the judge validates that every expected term is present and correctly
  defined.
  """
  if not expected_terms:
    return MetricResult("business_terms_validity", 1.0, True, "no terms expected")
  yaml_files, md_files = artifacts.get("yaml", {}), artifacts.get("overview_md", {})
  term_files = {p: (yaml_files.get(p) or md_files.get(p))
                for p in list(yaml_files) + list(md_files)
                if any(h in p.lower() for h in _TERM_FILE_HINTS)}
  if not term_files:
    return MetricResult(
        "business_terms_validity", 0.0, False,
        "The agent didn't write a dedicated file for each business term yet "
        "(an expected gap for now — the terms may still appear inline in the "
        "overview, which business_terms_presence checks).")
  if judge is None:
    return MetricResult(
        "business_terms_validity", 1.0, True,
        f"Found {len(term_files)} dedicated business-term file(s); turn on the "
        "LLM judge to validate that each one accurately defines its term.")
  blob = "\n\n".join(f"### {p}\n{c}" for p, c in term_files.items() if c)
  prompt = ("Validate dedicated business-term files: each EXPECTED TERM must have "
            "its own standalone file that ACCURATELY defines it.\n"
            f"EXPECTED TERMS: {expected_terms}\n\nTERM FILES:\n" + blob[:40000] +
            '\n\nReturn STRICT JSON: {"score":<0..1 fraction present+correctly defined>,'
            '"missing_or_invalid":[<terms>],"rationale":"<one sentence>"}')
  res = parse_json_obj(judge(prompt))
  score = float(res.get("score", 0) or 0)
  bad = res.get("missing_or_invalid") or []
  base = (res.get("rationale", "").strip()
          or f"{len(term_files)} dedicated business-term file(s) were checked.")
  return MetricResult("business_terms_validity", score, score >= 0.99,
                      base + (f" Missing or incorrectly defined: {', '.join(bad)}."
                              if bad else ""))


def score_rubric(artifacts: dict, judge: Judge,
                 expected_terms: list[str] | None = None) -> list[MetricResult]:
  """Run the LLM-judge rubric over the generated mdcode in a SINGLE judge call.

  All rubric dimensions are scored at once (one prompt -> one JSON object keyed by
  dimension), instead of one call per dimension. Far fewer round-trips = much
  faster runs."""
  content = "\n\n".join(f"### {p}\n{t}"
                        for p, t in artifacts.get("overview_md", {}).items())
  if not content.strip():
    # Agent produced no overview (e.g. failed/quota-starved run). The judge has
    # nothing to evaluate -- short-circuit with a clear reason instead of a
    # misleading "no documentation provided", and skip the wasted judge call.
    return [MetricResult(name, 0.0, False,
                         "no overview produced by the agent -- nothing to "
                         "evaluate (see structural_validity / the agent run)")
            for name in _RUBRIC]
  criteria = "\n".join(f"- {name}: {desc}" for name, desc in _RUBRIC.items())
  prompt = (
      "You are a rigorous but fair Data Governance Auditor. Rate the generated "
      "data-catalog documentation on EACH criterion below.\n\n"
      "SCORING DISCIPLINE (rigorous, but don't be perverse):\n"
      "- Use the FULL 0..1 range and match the score to the actual quality.\n"
      "- 1.0 = genuinely PERFECT for this criterion, nothing at all to improve "
      "(should be rare). If you can name any real improvement, score < 1.0.\n"
      "- 0.9+ is fine for excellent work with almost nothing to improve.\n"
      "- Don't inflate mediocre or generic output: penalize boilerplate, vague "
      "claims, and merely restating the schema. But genuinely strong work should "
      "still earn a high score -- don't lowball good output.\n"
      "- Judge each criterion independently on its own merits.\n\n"
      "For every criterion give a score in [0,1], a rationale, and a concrete, "
      "actionable improvement (1-2 sentences each, as needed).\n"
      "BE SPECIFIC -- this is the most important part. When you flag a problem, "
      "NAME it and QUOTE/identify the exact offending content and explain WHY it's "
      "a problem. E.g. for absence_of_contradictions, state the two conflicting "
      "statements and why they conflict ('says join key is account_id in the "
      "overview but customer_id in the example'); for redundancy_index, point to "
      "the specific lines that just restate the schema. Generic rationales like "
      "'has some contradictions' are NOT acceptable.\n\n"
      f"CRITERIA:\n{criteria}\n\nDOCUMENTATION:\n{content[:60000]}\n\n"
      "Return STRICT JSON mapping EACH criterion name to an object, e.g.: "
      '{"redundancy_index":{"score":0.7,"rationale":"...","insights":"..."}, ...}')
  # The judge occasionally returns malformed/incomplete JSON for this batched call;
  # when that happens every dimension would silently default to score 0 with an
  # empty rationale (looks like the agent failed, but it's a judge-side flake).
  # Retry a couple times, and require at least one rubric key to be present.
  res = {}
  for _ in range(3):
    res = parse_json_obj(judge(prompt))
    if isinstance(res, dict) and any(k in res for k in _RUBRIC):
      break
  out = []
  for name in _RUBRIC:
    score, rationale, insights = _rubric_dimension(res.get(name))
    if score is None:
      # Couldn't get a score for this dimension -- do NOT pretend it's a real 0.
      # Flag it clearly and exclude it from the gate so a judge flake doesn't
      # tank the run; score None so it's skipped in aggregation.
      out.append(MetricResult(
          name, None, True,
          "Could not evaluate this run — the rubric judge returned an "
          "incomplete/unparseable response (a judge-side flake, not an agent "
          "problem). Re-run to get a score for this dimension.",
          extra={"judge_error": True}))
      continue
    out.append(MetricResult(name, score, score >= 0.7, rationale, insights))
  return out


def _rubric_dimension(v):
  """Pull (score, rationale, insights) from one rubric dimension's JSON value.

  Normally the judge returns a flat object {"score","rationale","insights"}. It
  sometimes instead nests one object PER overview file
  ({"foo.overview.md": {"score": ...}, ...}); in that case average the per-file
  scores and join their rationales so the dimension still gets a score instead of
  showing n/a. Returns (None, "", "") when no score can be recovered."""
  if not isinstance(v, dict):
    return None, "", ""
  if "score" in v:
    return float(v.get("score", 0) or 0), v.get("rationale", ""), v.get("insights", "")
  subs = [s for s in v.values() if isinstance(s, dict) and "score" in s]
  if subs:
    avg = sum(float(s.get("score", 0) or 0) for s in subs) / len(subs)
    rationale = " ".join(s.get("rationale", "") for s in subs if s.get("rationale"))
    insights = " ".join(s.get("insights", "") for s in subs if s.get("insights"))
    return round(avg, 3), rationale, insights
  return None, "", ""


def consistency_judge(run_entries: list[dict], judge: Judge) -> list | None:
  """SEMANTICALLY align entries across the runs of one agent-case.

  `run_entries` is a list (one per run) of {entry_name: overview_text}. Returns a
  list of distinct concepts, each with the run numbers it appears in and a
  content-consistency 0..1 (how consistent its FACTS are across the runs that have
  it). Used to score concept_consistency + content_consistency cross-run, matching
  by MEANING (e.g. 'reorder point' == 'replenishment trigger'). None on failure."""
  payload = [{"run": i + 1,
              "entries": [{"name": n, "overview": (t or "")[:1200]}
                          for n, t in re_.items()]}
             for i, re_ in enumerate(run_entries)]
  prompt = (
      "An enrichment agent was run multiple times on the SAME input. Align entries "
      "ACROSS runs that represent the SAME underlying concept SEMANTICALLY -- match "
      "by meaning, not by name/formatting (e.g. 'reorder point' and 'replenishment "
      "trigger', or 'lead-time' and 'lead_time', are the same concept). For each "
      "DISTINCT concept, report which run numbers contain it and a "
      "content_consistency 0..1 = how consistent the FACTS stated are across the "
      "runs that have it (1.0 = same facts, 0.0 = contradictory/divergent).\n\n"
      f"RUNS:\n{json.dumps(payload, indent=2)[:60000]}\n\n"
      'Return STRICT JSON: {"concepts":[{"name":"<concept>","runs":[<run numbers>],'
      '"content_consistency":<0..1>,"note":"<short, what differs if anything>"}]}')
  res = parse_json_obj(judge(prompt))
  cs = res.get("concepts")
  return cs if isinstance(cs, list) else None


def _chunk_text(text: str, size: int = 45000, overlap: int = 1500) -> list[str]:
  """Split a long grounding corpus into overlapping windows so NOTHING is
  truncated away (the old 50K cap silently dropped real source -> false
  'fabrication' flags on large corpora). Overlap keeps facts spanning a cut
  visible to at least one chunk."""
  text = text or ""
  if len(text) <= size:
    return [text] if text.strip() else []
  out, i = [], 0
  while i < len(text):
    out.append(text[i:i + size])
    i += size - overlap
  return out


def check_hallucination(artifacts: dict, source_context: str, judge: Judge,
                        extra_grounding: str = "") -> MetricResult:
  """Groundedness via per-claim, chunked, PARALLEL verification.

  Why this shape: the old single-shot judge capped the
  source at 50K chars and grounded only against prose. On large corpora that cut
  dropped real content (codenames flagged as fabricated); in table mode it
  ignored the schema/dataset facts the overview legitimately states. Now:
    1. extract atomic claims from the generated overviews (one judge call);
    2. ground against the FULL corpus (source + table schema/reference),
       chunked so nothing is truncated;
    3. fan the chunks out in parallel -- a claim is hallucinated ONLY if NO
       chunk supports it (supported-by-any = grounded).
  """
  # Join the overview BODIES only -- no file-name headers. Prepending
  # `### lead-time.overview.md` made the extractor invent structural meta-claims
  # ("the aspectType of lead-time.overview.md is ...generic.overview") that are
  # obviously absent from prose and tanked the score with noise.
  content = "\n\n---\n\n".join(t for t in artifacts.get("overview_md", {}).values()
                               if (t or "").strip())
  if not content.strip():
    return MetricResult("hallucination_free", 0.0, False,
                        "no overview produced by the agent -- nothing to "
                        "ground-check (see structural_validity)")
  grounding = (source_context or "")
  if extra_grounding:
    grounding += "\n\n=== TABLE SCHEMA / REFERENCE METADATA ===\n" + extra_grounding
  if not grounding.strip():
    # No grounding source reachable -> can't judge groundedness. Skip (None) and
    # exclude from the gate rather than flag every claim as fabricated.
    return MetricResult("hallucination_free", None, True,
                        "no grounding source available (Drive unreachable / no "
                        "source docs) -- groundedness not scored this run")

  # 1. Extract atomic, checkable claims from the generated overviews.
  cl_prompt = (
      "Extract the SUBSTANTIVE, checkable DOMAIN claims from the GENERATED "
      "documentation below — specific facts about the subject matter (systems, "
      "values, relationships, formulas, paths, behaviors, definitions, "
      "term-usage rules). One claim per item, self-contained.\n"
      "EXCLUDE: anything about the document/file itself (file names, aspect "
      "types, YAML/metadata field values, that a section or heading exists), and "
      "generic boilerplate ('this table is useful for analysis'). Only claims a "
      "domain reader would fact-check.\n\n"
      f"GENERATED:\n{content[:60000]}\n\n"
      'Return STRICT JSON: {"claims":[<claim strings>]}')
  # Retry extraction: a single judge hiccup returning {} / no claims would
  # otherwise score a FALSE perfect 1.0 ("no claims") on a content-rich overview.
  claims = []
  for _ in range(3):
    claims = parse_json_obj(judge(cl_prompt)).get("claims") or []
    claims = [str(c) for c in claims if str(c).strip()][:80]
    if claims:
      break
  if not claims:
    # Substantial prose but the extractor kept returning nothing -> almost
    # certainly a judge failure, not a genuinely claim-free overview. Skip
    # (None, excluded from the gate) rather than award a misleading 1.0.
    if len(content.strip()) > 2000:
      return MetricResult("hallucination_free", None, True,
                          "claim extraction failed (judge returned no claims for "
                          "a content-rich overview) -- groundedness not scored")
    return MetricResult("hallucination_free", 1.0, True,
                        "no checkable factual claims extracted from the overview")

  # 2/3. Ground each claim against EVERY chunk, in parallel. Supported-by-any wins.
  chunks = _chunk_text(grounding)
  numbered = "\n".join(f"{i}. {c}" for i, c in enumerate(claims))

  def _supported_in(chunk: str) -> set:
    p = ("For each numbered CLAIM, decide if it is SUPPORTED by (stated in, or "
         "directly inferable from) the SOURCE CHUNK. Schema/column/dataset facts "
         "count as supported if present in the chunk. Be lenient on paraphrase.\n\n"
         f"SOURCE CHUNK:\n{chunk[:48000]}\n\nCLAIMS:\n{numbered}\n\n"
         'Return STRICT JSON: {"supported":[<indices of supported claims>]}')
    idxs = parse_json_obj(judge(p)).get("supported") or []
    out = set()
    for x in idxs:
      try:
        out.add(int(x))
      except (TypeError, ValueError):
        pass
    return out

  supported: set = set()
  if len(chunks) == 1:
    supported = _supported_in(chunks[0])
  else:
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
      for s in ex.map(_supported_in, chunks):
        supported |= s

  unsupported = [c for i, c in enumerate(claims) if i not in supported]
  score = round(1.0 - len(unsupported) / len(claims), 3)
  detail = (f"All {len(claims)} extracted claims are grounded in the source "
            f"(+schema) across {len(chunks)} chunk(s)."
            if not unsupported else
            f"{len(unsupported)} of {len(claims)} claims unsupported by the source "
            f"(checked across {len(chunks)} chunk(s)) — e.g.: "
            + "; ".join(_clip(c, 240) for c in unsupported[:3]))
  return MetricResult("hallucination_free", score,
                      not unsupported and score >= 0.99, _clip(detail, 1800),
                      extra={"unsupported_claims": unsupported[:20],
                             "n_claims": len(claims), "n_chunks": len(chunks)})


def check_persona_alignment(artifacts: dict, persona: dict,
                            judge: Judge) -> MetricResult:
  """Persona/instruction conditioning: does the output EMPHASIZE this persona's
  focus areas while still RETAINING the shared high-level concepts?

  This is an emphasis-shift test, not a coverage test: the same source doc is
  enriched under two different user instructions, and each output should lean into
  that persona's focus_areas. Crucially, the shared_concepts must still be present
  (a persona shifts emphasis, it does not delete the rest of the document).

  Score = 0.8 * mean(focus prominence) + 0.2 * mean(shared present). Prominence is
  0 (absent) / 0.5 (mentioned in passing) / 1 (prominent / detailed); shared is
  0/1. Rewards emphasis but docks dropped shared concepts.
  """
  content = "\n\n---\n\n".join(t for t in artifacts.get("overview_md", {}).values()
                               if (t or "").strip())
  if not content.strip():
    return MetricResult("persona_alignment", 0.0, False,
                        "no overview produced -- nothing to score")
  focus = [str(f) for f in (persona.get("focus_areas") or []) if str(f).strip()]
  shared = [str(s) for s in (persona.get("shared_concepts") or []) if str(s).strip()]
  instruction = persona.get("instruction", "")
  prompt = (
      "A knowledge base was generated from a source document under a specific USER "
      "INSTRUCTION (persona). Judge how well the output matches that persona.\n\n"
      f"USER INSTRUCTION:\n{instruction}\n\n"
      "For each FOCUS AREA (what this persona wants emphasized), rate PROMINENCE: "
      "0.0 = absent, 0.5 = mentioned only in passing, 1.0 = prominent / covered in "
      "detail. For each SHARED CONCEPT (high-level context that must NOT be dropped "
      "even though it's not this persona's focus), rate PRESENT: 1 if present at "
      "all, else 0.\n\n"
      f"FOCUS AREAS:\n{json.dumps(focus, indent=2)}\n\n"
      f"SHARED CONCEPTS:\n{json.dumps(shared, indent=2)}\n\n"
      f"GENERATED KNOWLEDGE BASE:\n{content[:60000]}\n\n"
      'Return STRICT JSON: {"focus":[{"area":"<area>","prominence":<0..1>}],'
      '"shared":[{"concept":"<concept>","present":<0 or 1>}],'
      '"rationale":"<one sentence naming what was emphasized vs shallow and any '
      'shared concept dropped>"}')
  res = parse_json_obj(judge(prompt))
  fres = {str(x.get("area")): x for x in (res.get("focus") or []) if isinstance(x, dict)}
  sres = {str(x.get("concept")): x for x in (res.get("shared") or []) if isinstance(x, dict)}
  def _num(x, default=0.0):
    try:
      return max(0.0, min(1.0, float(x)))
    except (TypeError, ValueError):
      return default
  fprom = [_num(fres.get(a, {}).get("prominence")) for a in focus]
  spres = [_num(sres.get(s, {}).get("present")) for s in shared]
  # Deterministic backstop (same idea as concept_recall, #42): the judge can
  # under-rate prominence even when a focus area has its OWN dedicated entry. If a
  # produced entry name clearly maps to a focus area (>=2 shared significant
  # tokens), that area IS prominently covered -> floor its prominence at 0.75 so a
  # lukewarm judge can't sink it. Only raises, never lowers.
  _noise = {"id", "md", "overview", "the", "a", "an", "of", "and", "or", "to",
            "plus", "file", "files", "stage"}
  produced_basenames = [re.sub(r"\.(overview\.md|md|yaml)$", "", os.path.basename(p))
                        for p in artifacts.get("overview_md", {})]
  ent_tokens = [(_name_tokens(b) - _noise) for b in produced_basenames]
  floored = []
  for i, area in enumerate(focus):
    if fprom[i] >= 0.75:
      continue
    ftoks = _name_tokens(area) - _noise
    if any(et and len(ftoks & et) >= 2 for et in ent_tokens):
      fprom[i] = max(fprom[i], 0.75)  # dedicated entry => prominently covered
      floored.append(area)
  mean_focus = sum(fprom) / len(fprom) if fprom else 0.0
  mean_shared = sum(spres) / len(spres) if spres else 1.0
  score = round(0.8 * mean_focus + 0.2 * mean_shared, 3)
  emphasized = [a for a, p in zip(focus, fprom) if p >= 0.75]
  shallow = [a for a, p in zip(focus, fprom) if p < 0.5]
  dropped = [s for s, p in zip(shared, spres) if p < 0.5]
  parts = [f"Emphasized {len(emphasized)}/{len(focus)} focus areas"
           + (f" (well: {', '.join(emphasized[:4])})" if emphasized else "")]
  if shallow:
    parts.append("shallow/absent: " + ", ".join(shallow[:4]))
  parts.append("all shared concepts retained" if not dropped
               else "DROPPED shared concept(s): " + ", ".join(dropped))
  if floored:
    parts.append(f"{len(floored)} area(s) credited via a dedicated entry the judge "
                 "under-rated")
  base = (res.get("rationale", "") or "").strip()
  detail = (". ".join(parts) + ".") + (f" {base}" if base else "")
  thr = 0.6
  return MetricResult("persona_alignment", score, score >= thr, _clip(detail, 1800),
                      extra={"mean_focus": round(mean_focus, 3),
                             "mean_shared": round(mean_shared, 3),
                             "shallow": shallow, "dropped_shared": dropped,
                             "name_floored": floored})


# Plain-English labels so the explainer (and any fallback) talks about metrics
# the way a developer would, not by their internal snake_case name.
_METRIC_LABEL = {
    "structural_validity": "structural validity (is the output valid Metadata-as-Code)",
    "trajectory": "tool trajectory (did the agent use the right sources for its inputs)",
    "perf": "performance (latency and output size vs budget)",
    "business_terms_presence": "business-term presence (are expected terms covered)",
    "business_terms_validity": "business-term validity (dedicated, correctly-defined term files)",
    "context_preservation": "context preservation (pre-baked entry context survives enrichment)",
    "concept_recall": "concept recall (did it cover the expected topics)",
    "concept_precision": "concept precision (are produced entries on-topic)",
    "fact_recall": "fact recall (did it capture the golden facts)",
    "redundancy_index": "information density (novel synthesis vs restating the schema)",
    "enrichment_diversity": "expected sections covered (e.g. Lineage, Sample Queries)",
    "disambiguation_efficacy": "disambiguation (distinct from similar entries)",
    "absence_of_contradictions": "absence of contradictions",
    "hallucination_free": "groundedness (claims supported by the sources)",
    "persona_alignment": "persona alignment (output emphasizes the user persona's focus, retains shared concepts)",
}


def explain_metrics(metric_list: list[dict], mode: str,
                    judge: Judge | None,
                    baselines: dict | None = None) -> dict[str, dict]:
  """Turn raw metric evidence into human-readable rationale + insights per metric.

  Takes ALL of a single agent-case's metrics at once (name, score, passed, and
  the metric's own deterministic/judge `detail` as evidence) and asks the LLM to
  write, for each, a plain-English `rationale` (why it scored that) and a concrete
  `insights` (how to improve, or "" if passing). This is intentionally
  non-deterministic — the reasoning comes from the model, grounded in the
  evidence. Returns {metric_name: {"rationale": str, "insights": str}}; returns
  {} when no judge is supplied (callers fall back to the deterministic detail).
  """
  if judge is None or not metric_list:
    return {}
  baselines = baselines or {}
  payload = [{"metric": m.get("name"),
              "label": _METRIC_LABEL.get(m.get("name"), m.get("name")),
              "score": m.get("score"), "passed": m.get("passed"),
              # Per-run signal so the explainer can detect flakiness/variance.
              "per_run_scores": m.get("run_scores"),
              "runs_passed": m.get("runs_passed"),
              # Optional baseline mean for the same metric (e.g. a prior run).
              "comparison_baseline_other_version": baselines.get(m.get("name")),
              "evidence": (m.get("detail") or "").strip()}
             for m in metric_list]
  prompt = (
      "You are explaining knowledge-catalog enrichment-agent eval results to a "
      f"developer who wants to IMPROVE the agent. The agent was run MULTIPLE times "
      f"in '{mode}' mode; each metric includes 'score' (mean across runs), "
      "'per_run_scores' (each run's score, IN RUN ORDER: the first element is Run 1, "
      "the second is Run 2, etc.), 'runs_passed', 'comparison_baseline_other_version' "
      "(an optional baseline mean for the same metric, e.g. from a prior run), and 'evidence' (the "
      "concrete findings). Using ONLY the evidence (do not invent facts), write for "
      "EVERY metric:\n"
      "  - rationale (1-3 sentences): WHY it got this score. Be SPECIFIC and "
      "DETAILED -- the evidence usually names concrete items (the extra/unexpected "
      "entry, the exact missing facts, the actual contradicting statements, token "
      "counts, missing sections). PRESERVE those specifics in your rationale: name "
      "the extra entry, list the missing facts, quote the contradiction. Do NOT "
      "flatten to a generic high-level summary. SURFACE PER-RUN VARIANCE BY RUN "
      "NUMBER: when per_run_scores differ, state the scores AND name the specific "
      "run(s) that were lower so the developer can open them (e.g. 'averaged 0.9 -- "
      "Run 1 was 1.0 but Run 2 dropped to 0.8'); call it flaky/transient if it "
      "varies, stable/systematic if consistent. Reference the baseline when it "
      "differs (e.g. 'vs the baseline 0.875').\n"
      "  - insights (1-2 sentences, REQUIRED, never empty): the concrete next "
      "improvement, tied to the specific gap named in the rationale (e.g. 'drop the "
      "spurious UPC/GTIN entry by tightening the topic filter', or 'add the missing "
      "ROP formula fact'). When a specific run was lower, tell them to investigate "
      "that run number (e.g. 'investigate why Run 2 dropped to 0.8'). If genuinely "
      "perfect and stable, say what would make it even stronger.\n"
      "Be specific and readable; avoid internal metric jargon.\n\n"
      f"METRICS:\n{json.dumps(payload, indent=2)}\n\n"
      'Return STRICT JSON mapping EVERY metric name to an object, e.g.: '
      '{"trajectory":{"rationale":"...","insights":"..."}, ...}')
  res = parse_json(judge(prompt))
  if not isinstance(res, dict):
    return {}
  out: dict[str, dict] = {}
  for name, v in res.items():
    if isinstance(v, dict):
      out[name] = {"rationale": str(v.get("rationale", "") or "").strip(),
                   "insights": str(v.get("insights", "") or "").strip()}
  return out


def default_judge(model: str = "gemini-2.5-pro") -> Judge:
  """Vertex Gemini judge (ADC project/location from env). Lazy import.

  Bounded + retried: a per-request timeout (no infinite hang) and a few retries
  on transient errors (timeouts / 429). On exhaustion returns "" so the caller's
  parse_json_obj yields {} and the metric degrades to None (excluded from the
  gate) instead of stalling the whole run forever -- a single stuck Vertex call
  used to hang an entire eval case.
  """
  def _judge(prompt: str) -> str:
    import os
    import time
    from google.genai import Client  # pytype: disable=import-error
    from google.genai.types import HttpOptions  # pytype: disable=import-error
    from google.auth import default as _adc
    creds, _ = _adc()
    client = Client(vertexai=True, credentials=creds,
                    project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
                    location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
                    http_options=HttpOptions(timeout=180_000))  # ms
    last = ""
    for attempt in range(3):
      try:
        resp = client.models.generate_content(model=model, contents=prompt)
        return resp.text or ""
      except Exception as e:  # pylint: disable=broad-except
        last = str(e)
        time.sleep(8 * (attempt + 1))
    print(f"[judge] giving up after retries: {last[:200]}", flush=True)
    return ""
  return _judge
