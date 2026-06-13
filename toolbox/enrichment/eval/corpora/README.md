# Enrichment eval corpora

Synthetic, publishable Markdown source documents for **doc-mode golden evaluation**.
Three self-contained domains, ~11 docs each:

- `financial_services/`
- `phone_services/`
- `supply_chain/`

These let customers run doc-mode (and table/overlay grounding) golden evals from
**local files** — no need to convert anything into Google Docs. Point the agent's
`--docs` / `--folder` at a domain folder, e.g.:

```bash
python3 toolbox/enrichment/src/agent_runner.py --mode=doc \
  --folder=toolbox/enrichment/eval/corpora/supply_chain \
  --entry_group=<project>.<location>.<entryGroupId> \
  --project=<project> --model=gemini-2.5-pro --output_dir=/tmp/out
```

All content is synthetic (safe to publish); it carries no provenance/eval labels
in the document bodies so it doesn't bias the agent.
