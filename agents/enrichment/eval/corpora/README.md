# Enrichment eval corpora

Synthetic, publishable Markdown source documents that the bundled goldens ground
on — so the eval runs from **local files**, no Google Drive required. Each folder
is self-contained.

**Doc-mode domains** (~11 docs each):

- `financial_services/`
- `phone_services/`
- `supply_chain/`

**Dataset-grounding corpora** (feed table / context_overlay / hybrid goldens for
the matching public dataset):

- `thelook_ecommerce/` — grounds `thelook_ecommerce.json` (table)
- `crypto_bitcoin/` — grounds `table_crypto_bitcoin.json` / `overlay_crypto_bitcoin.json`
- `ga4_obfuscated_sample_ecommerce/` — grounds the `*_ga4_obfuscated_sample_ecommerce` goldens
- `stackoverflow/` — grounds `table_stackoverflow.json` (table) and
  `hybrid_stackoverflow.json` (hybrid = doc + `--dataset`)
- `stackoverflow_xref/` — grounds `xref_stackoverflow.json` (cross-table showcase)

These let customers run doc-mode (and table / overlay / hybrid grounding) golden
evals from **local files** — no need to convert anything into Google Docs. Point
the agent's `--docs` / `--folders` at a domain folder, e.g.:

```bash
python3 agents/enrichment/src/agent_runner.py --mode=doc \
  --folder=agents/enrichment/eval/corpora/supply_chain \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<project> --model=gemini-2.5-pro --output_dir=/tmp/out
```

All content is synthetic (safe to publish); it carries no provenance/eval labels
in the document bodies so it doesn't bias the agent.
