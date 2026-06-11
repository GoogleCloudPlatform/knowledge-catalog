# Golden files

A **golden** declares what an enrichment run *should* contain for a given input,
so the eval can score the output against it. Dynamic (golden-free) eval grounds
only in what the agent retrieved; a golden adds **concept recall/precision**,
**fact recall**, **section coverage**, **term coverage**, and (optionally)
**persona alignment**.

Run it:

```bash
cd toolbox/enrichment
python -m eval --output-dir <run output> --golden eval/goldens/example_ga_events.json
```

(Same judge auth as dynamic eval — `GOOGLE_CLOUD_PROJECT` + ADC.)

## Schema

Keep the fields that fit your mode (see `TEMPLATE.json`):

| Field | Mode | Drives | Meaning |
|-------|------|--------|---------|
| `expected_topics` | doc | concept_recall, concept_precision, fact_recall | List of `{canonical, flavor_hints[], golden_facts[]}` — the concepts you expect as entries. `flavor_hints` are synonyms the judge treats as the same concept; `golden_facts` are statements the entry should convey. |
| `acceptable_extra_concepts` | doc | concept_precision | Optional concepts that are fine to produce and **won't** count against precision (string or `{name, aliases[]}`). |
| `tables` | table | fact_recall | List of `{table, golden_facts[]}` — each table's expected facts. |
| `expected_headings` | both | enrichment_diversity | Sections the overview should contain (e.g. `Lineage`, `Sample Queries`). |
| `business_terms` | both | business_terms_presence | Terms the output should cover. |
| `personas` | doc | persona_alignment | `{id: {instruction, focus_areas[], shared_concepts[]}}` — run with `--persona <id>`. |

The eval auto-detects mode from the run's `trajectory.json` (`agent_type`), so use
`expected_topics` for doc runs and `tables` for table runs.

## How to build goldens — three sources

1. **Author them deliberately.** Hand-write `golden_facts`/`expected_topics` for the
   scenarios and failure modes you care about (synonyms, contradictions, ambiguous
   entities). Start small; `TEMPLATE.json` shows every field.

2. **Work backward from already-documented data.** Take a dataset that already has
   good human-written descriptions, **keep the source the agent reads** (schema,
   sample data, source docs) but **hold out the human descriptions**, run the agent,
   and use those held-out descriptions as `golden_facts`. The existing documentation
   becomes a large, real golden set "for free." Filter to facts the source actually
   supports (don't include tribal knowledge the agent could never recover).

3. **Harvest from human review (HITL).** When a person approves or edits a generated
   entry, capture the approved/corrected output as a golden. The set then grows
   continuously from real usage instead of being authored once.

## Notes

- A golden is a strong but imperfect oracle: a good agent can sometimes write
  something correct that your golden didn't list (a false "miss") — spot-check
  low scores.
- Keep facts atomic and checkable; the judge matches them semantically (paraphrase
  is fine), it does not require exact wording.
