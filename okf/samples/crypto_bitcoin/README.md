# Bitcoin public dataset sample

Runs the enrichment agent against the public
`bigquery-public-data.crypto_bitcoin` dataset (blocks, transactions,
inputs, outputs — produced by the open-source `bitcoin-etl` pipeline)
and seeds the web pass with the canonical schema source and the
foundational Google Cloud blockchain-on-BigQuery announcement.

This sample contrasts with GA4 (single denormalized events table) and
Stack Overflow (many independent entities) by exercising a **small set
of tightly related fact tables** where each row in `transactions`
references rows in `blocks`, `inputs`, and `outputs`. Good for seeing
how the agent surfaces cross-table foreign-key relationships in prose.

## Prerequisites

- Install the agent (from the repo root):
  ```
  python3.13 -m venv .venv
  .venv/bin/pip install --index-url https://pypi.org/simple/ -e .[dev]
  ```
- BigQuery access:
  ```
  gcloud auth application-default login
  gcloud config set project <your-billing-project>
  ```
  Public datasets are readable, but the caller's project is billed for
  query bytes. The `crypto_bitcoin` tables are very large
  (`transactions` is ~hundreds of GB) — keep `--web-max-pages` modest
  while iterating and prefer `--concept` for smoke runs.
- Gemini credentials — either `GEMINI_API_KEY` (AI Studio) **or** Vertex
  AI (`GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=<id>`,
  `GOOGLE_CLOUD_LOCATION=<region>`).

## Run

```
.venv/bin/python -m enrichment_agent enrich \
    --source bq \
    --dataset bigquery-public-data.crypto_bitcoin \
    --web-seed-file samples/crypto_bitcoin/seeds.txt \
    --out ./bundles/crypto_bitcoin
```

To iterate on a single concept, add `--concept tables/transactions`.
To skip the web pass, add `--no-web`. To raise or lower the web budget,
use `--web-max-pages N` (default 100).

## What you get

A bundle under `./bundles/crypto_bitcoin/` with one OKF doc per BQ
concept (dataset + each table), augmented and cross-linked with
reference docs minted from the seeded blockchain-etl and Google Cloud
pages, plus an auto-generated `index.md` at each directory level.
