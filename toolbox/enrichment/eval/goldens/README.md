# Golden files

A **golden** declares what an enrichment run *should* contain for a given input,
so the eval can score the output against it. Dynamic (golden-free) eval grounds
only in what the agent retrieved; a golden adds **concept recall/precision**,
**fact recall**, **section coverage**, **term coverage**, and (optionally)
**persona alignment**.

Run it (every bundled golden has a `run` block, so `--run` does the agent run +
scoring for you):

```bash
cd toolbox/enrichment
python -m eval --run --goldens eval/goldens/supply_chain.json --project <your_gcp_project>
# or score an output you already produced:
python -m eval --output-dir <run output> --golden eval/goldens/supply_chain.json
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
`expected_topics` for doc runs and `tables` for table runs. **`context_overlay`**
runs keep their own mode (matching the internal harness): structural validity
skips the entry-type check (overlay entries are `generic`, mixed with read-only
`.ref` bigquery entries), and the table-only metrics — `entry_grounding`,
reference grounding, per-table `fact_recall` — don't apply. Score an overlay
golden with `business_terms` / `expected_headings` (and rely on the trajectory
for `hallucination_free`).

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

## theLook eCommerce — runnable table-mode golden (out-of-the-box)

`thelook_ecommerce.json` is a ready-to-run **table-mode** golden built on the
public BigQuery dataset `bigquery-public-data.thelook_ecommerce` (a synthetic
multi-brand online retailer) and grounded by the local markdown corpus under
`eval/corpora/thelook_ecommerce/` (4 docs: business glossary, order lifecycle,
data model, metrics) — no Google Drive needed.

Run it end-to-end with **one command** (from `toolbox/enrichment/`). The eval does
everything from the golden's `run` block — copies the public dataset into your
project (idempotent), enriches it in table mode grounded by the local corpus, and
scores it. You only pass your project:

```bash
python -m eval --run --goldens eval/goldens/thelook_ecommerce.json \
    --project <your_gcp_project> --model gemini-2.5-pro --runs 3
```

That gives run-level + averaged metrics across 3 runs and writes the reports to a
timestamped folder under `$TMPDIR/kc_golden_eval_reports/`. Prereqs: ADC
(`gcloud auth application-default login`) and a built `kcmd`
(`cd toolbox/mdcode && npm run build`).

The golden scores per-table `golden_facts` (fact recall), `business_terms`
coverage, and `expected_headings` — all stated in / derivable from the grounding
corpus. (You don't run `bq` or the agent yourself — `--run` handles the
copy-public-dataset setup and the agent run; see "Run a golden as a CASE" below
for the `run`-block schema and how to author your own cases.)

## Run a golden as a CASE (`--run`) — including your own

Add a `run` block to any golden to make it a runnable **case**: `python -m eval
--run` then generates the Metadata-as-Code itself (you don't pre-run the agent),
repeats it `--runs` times, scores each, and reports run-level + averaged metrics.
This mirrors the internal Evaluation tab (single agent).

```jsonc
"run": {
  "mode": "table",                 // "table" | "doc" | "context_overlay"
  "topic": "Metadata enrichment",
  "folders": "eval/corpora/my_corpus",   // local dirs and/or Drive folders (comma-sep); relative to toolbox/enrichment
  "docs": "https://docs.google.com/...,./notes/x.md",  // optional, mixed
  "entry_group": "proj.location.my-eg",  // required for doc / context_overlay
  "dataset": "proj.my_dataset",          // table / context_overlay (omit if using setup below)
  "setup": {                              // optional: copy a public dataset into your project first
    "copy_public_dataset": {"source": "bigquery-public-data.thelook_ecommerce", "dataset": "thelook_ecommerce"}
  }
}
```

Run it (works for any golden with a `run` block — your own cases included):

```bash
python -m eval --run --goldens eval/goldens/thelook_ecommerce.json \
    --project <your_gcp_project> --runs 3 --concurrency 2
# several at once:
python -m eval --run --goldens eval/goldens/a.json,eval/goldens/b.json --project <p>
```

- `--runs N` (default 3 in `--run` mode): per-run + averaged metrics, plus the
  cross-run **concept_consistency** / **content_consistency** stability metrics
  (informational; shown only when there are ≥2 independent runs — omitted
  otherwise, since consistency is undefined for a single run).
- `--concurrency` (default 2, env `KC_EVAL_MAX_CONCURRENCY`): max concurrent agent
  processes; the agent also caps its own per-mode LLM concurrency, so keep this low.
- Reports land in a timestamped run folder
  (`$TMPDIR/kc_golden_eval_reports/golden_run_<time>_<id>/`) with one report per
  `<golden>/run<i>.md`, an **averaged `<golden>/aggregate.md`** (the mean metrics
  with full untruncated rationale, per-metric run scores, and a per-run
  breakdown — what the terminal scorecard truncates), plus a `manifest.json`.
- Prereqs for `--run`: ADC (`gcloud auth application-default login`) and a built
  `kcmd` (`cd toolbox/mdcode && npm run build`) — every mode (doc included) shells
  out to it (`kcmd init`/`pull`).

## Bundled runnable goldens

All four shipped goldens have a `run` block, so each is one-command:

| Golden | Mode | Setup |
|--------|------|-------|
| `thelook_ecommerce.json` | table | copies `bigquery-public-data.thelook_ecommerce` into your project |
| `financial_services.json` | doc | grounds on `eval/corpora/financial_services` |
| `phone_services.json` | doc | grounds on `eval/corpora/phone_services` |
| `supply_chain.json` | doc | grounds on `eval/corpora/supply_chain` |

The doc goldens declare a generalizable `entry_group` of the form
`{project}.global.kc-eval-<name>` — the `{project}` placeholder is replaced with
your `--project` at run time, so nothing in the golden is hardwired to one
project. Run them like any other case:

```bash
# one doc case
python -m eval --run --goldens eval/goldens/financial_services.json --project <p>
# all four at once
python -m eval --run --project <p> --goldens \
  eval/goldens/thelook_ecommerce.json,eval/goldens/financial_services.json,eval/goldens/phone_services.json,eval/goldens/supply_chain.json
```

(All cases need a built `kcmd` — every mode runs `kcmd init`/`pull`. The table
case additionally needs BigQuery access for the dataset copy.)

## Notes

- A golden is a strong but imperfect oracle: a good agent can sometimes write
  something correct that your golden didn't list (a false "miss") — spot-check
  low scores.
- Keep facts atomic and checkable; the judge matches them semantically (paraphrase
  is fine), it does not require exact wording.
