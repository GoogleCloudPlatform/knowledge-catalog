# Golden files

A **golden** declares what an enrichment run *should* contain for a given input,
so the eval can score the output against it. Dynamic (golden-free) eval grounds
only in what the agent retrieved; a golden adds **concept recall/precision**,
**fact recall**, **section coverage**, **term coverage**, and (optionally)
**persona alignment**.

Run it (every bundled golden has a `run` block, so `--run` does the agent run +
scoring for you):

```bash
cd agents/enrichment
python -m eval --run --goldens eval/goldens/supply_chain.json --project <your_gcp_project>
# or score an output you already produced:
python -m eval --output-dir <run output> --golden eval/goldens/supply_chain.json
```

(Same judge auth as dynamic eval — `GOOGLE_CLOUD_PROJECT` + ADC.)

## Schema

Keep the fields that fit your mode (see `TEMPLATE.json`):

| Field | Mode | Drives | Meaning |
|-------|------|--------|---------|
| `expected_topics` | doc, hybrid | concept_recall, concept_precision, fact_recall | List of `{canonical, flavor_hints[], golden_facts[]}` — the concepts you expect as entries. `flavor_hints` are synonyms the judge treats as the same concept; `golden_facts` are statements the entry should convey. |
| `acceptable_extra_concepts` | doc | concept_precision | Optional concepts that are fine to produce and **won't** count against precision (string or `{name, aliases[]}`). |
| `tables` | table, context_overlay, hybrid | fact_recall | List of `{table, golden_facts[]}` — each table's expected facts. Scored per-table for table/overlay; in **hybrid** the per-table overlay facts and the doc-side concept facts combine into one `fact_recall`. |
| `expected_folders` | doc, context_overlay, hybrid | index_name_coverage | Per-folder/category names the agent's `index` entries should cover (token-overlap match). |
| `expected_headings` | both | enrichment_diversity | Sections the overview should contain (e.g. `Lineage`, `Sample Queries`). |
| `business_terms` | both | business_terms_presence, business_terms_validity | Terms the output should cover (presence) + whether each gets a dedicated per-term definition file (validity). |
| `personas` | doc | persona_alignment | `{id: {instruction, focus_areas[], shared_concepts[]}}` — run with `--persona <id>`. |
| `prebaked_facts` | both | context_preservation | Facts that existed before enrichment and must be PRESERVED (not clobbered) through the run. |
| `trajectory` | both | trajectory | `{must_call: [...], must_not_call: [...]}` — tool categories the agent must / must not use (`drive_fetch`, `dataset_pull`, `github_fetch`). Checked against the actual `trajectory.json` tool calls. |

Every golden run also gets the **dynamic** metrics automatically:
`structural_validity`, `perf`, `hallucination_free`, and the rubric dims
`redundancy_index` / `disambiguation_efficacy` / `absence_of_contradictions` — so
a golden only needs to declare the golden-specific fields above.

The eval auto-detects mode from the run's `trajectory.json` (`agent_type`) and
dispatches scoring accordingly:

- **doc / hybrid** → `expected_topics` drives `concept_recall` (+ `concept_precision`
  for doc) and the concept-side `fact_recall`.
- **table / context_overlay / hybrid** → `tables` drives the per-table `fact_recall`.
  **hybrid is scored on BOTH** sides (its KB concepts *and* its per-table overlays)
  and the two contributions combine into one `fact_recall`.
- **entry_grounding** runs for **table + context_overlay** (every generated entry must
  map to a real dataset table); it is **skipped for hybrid**, whose standalone KB
  entries are legitimately not tables.
- **index_name_coverage** runs for doc / context_overlay / hybrid when the golden
  declares `expected_folders`.

`context_overlay` still relaxes one structural check — overlay entries are `generic`
and mixed with read-only `.ref` bigquery entries, so structural validity skips the
entry-type match — but it now earns a real per-table `fact_recall`, `entry_grounding`,
and `index_name_coverage` just like table mode (this changed from the earlier
reference design, where overlay was scored only on `business_terms` /
`expected_headings`).

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

Run it end-to-end with **one command** (from `agents/enrichment/`). The eval does
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
(`cd agents/mdcode && npm run build`).

The golden scores per-table `golden_facts` (fact recall), `business_terms`
coverage, and `expected_headings` — all stated in / derivable from the grounding
corpus. (You don't run `bq` or the agent yourself — `--run` handles the
copy-public-dataset setup and the agent run; see "Run a golden as a CASE" below
for the `run`-block schema and how to author your own cases.)

## Run a golden as a CASE (`--run`) — including your own

Add a `run` block to any golden to make it a runnable **case**: `python -m eval
--run` then generates the Metadata-as-Code itself (you don't pre-run the agent),
repeats it `--runs` times, scores each, and reports run-level + averaged metrics.
This mirrors a single-agent eval (single agent).

```jsonc
"run": {
  "mode": "table",                 // "table" | "doc" | "context_overlay"  (hybrid = "doc" + a "dataset")
  "topic": "Metadata enrichment",
  "folders": "eval/corpora/my_corpus",   // local dirs and/or Drive folders (comma-sep); relative to agents/enrichment
  "docs": "https://docs.google.com/...,./notes/x.md",  // optional, mixed
  "entry_group": "proj.location.my-eg",  // required for doc / context_overlay
  "dataset": "proj.my_dataset",          // table / context_overlay (omit if using setup below)
  "setup": {                              // optional: prepare the dataset in your project first
    // either copy a public dataset wholesale...
    "copy_public_dataset": {"source": "bigquery-public-data.thelook_ecommerce", "dataset": "thelook_ecommerce"}
    // ...or build a schema-only, descriptions-stripped replica (large/described sources):
    // "schema_only_replica": {"builder": "make_public_replica.py", "source": "bigquery-public-data.stackoverflow", "dataset": "stackoverflow", "tables": ["posts_questions","users"]}
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
  `kcmd` (`cd agents/mdcode && npm run build`) — every mode (doc included) shells
  out to it (`kcmd init`/`pull`).

## Bundled runnable goldens

All shipped goldens have a `run` block, so each is one-command:

| Golden | Mode | Setup |
|--------|------|-------|
| `thelook_ecommerce.json` | table | copies `bigquery-public-data.thelook_ecommerce` into your project |
| `table_crypto_bitcoin.json` | table | schema-only replica of `bigquery-public-data.crypto_bitcoin` (cross-table FK sample) |
| `table_ga4_obfuscated_sample_ecommerce.json` | table | schema-only replica of `bigquery-public-data.ga4_obfuscated_sample_ecommerce` (single wide nested-RECORD table) |
| `table_stackoverflow.json` | table | schema-only 7-table replica of `bigquery-public-data.stackoverflow` (many independent entities) |
| `xref_stackoverflow.json` | table | schema-only stackoverflow replica — **cross-table showcase**: FKs documented child-side only, so a parent table's inbound refs require cross-table aggregation |
| `overlay_crypto_bitcoin.json` | context_overlay | schema-only crypto_bitcoin replica; writes overlay entries into `{project}.global.kc-eval-overlay` |
| `overlay_ga4_obfuscated_sample_ecommerce.json` | context_overlay | schema-only ga4 replica; overlay entries into `{project}.global.kc-eval-overlay` |
| `hybrid_stackoverflow.json` | hybrid (doc CLI + `--dataset`) | schema-only stackoverflow replica + local corpus; KB entries **plus** per-table overlays into `{project}.global.kc-eval-hybrid` |
| `financial_services.json` | doc | grounds on `eval/corpora/financial_services` |
| `phone_services.json` | doc | grounds on `eval/corpora/phone_services` |
| `supply_chain.json` | doc | grounds on `eval/corpora/supply_chain` |

> **context_overlay + hybrid** write to an entry group you own
> (`{project}.global.kc-eval-overlay` / `kc-eval-hybrid`, the `{project}` placeholder
> filled from `--project`). The group need not pre-exist — `kcmd pull` tolerates a
> missing group and nothing is published unless *you* later `kcmd push`.

The three `table_*` cases above use a **schema-only replica** rather than a full
copy: their public sources are large and ship rich column descriptions, so the
setup builds empty, descriptions-stripped tables in your project (via
`eval/tools/make_public_replica.py` / `make_crypto_bitcoin_replica.py`) — so
enrichment is measured from the grounding corpus, not the schema. `--run` builds
the replica automatically (see the `schema_only_replica` setup below).

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
