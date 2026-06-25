# GA4 Google Merchandise Store sample

Runs the reference agent against the public
`bigquery-public-data.ga4_obfuscated_sample_ecommerce` dataset (a GA4 export
from the Google Merchandise Store) and seeds the web pass with canonical GA4
BigQuery Export documentation URLs.

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
  query bytes.
- Gemini credentials — either `GEMINI_API_KEY` (AI Studio) **or** Vertex
  AI (`GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=<id>`,
  `GOOGLE_CLOUD_LOCATION=<region>`).

## Run

```
.venv/bin/python -m reference_agent enrich \
    --source bq \
    --dataset bigquery-public-data.ga4_obfuscated_sample_ecommerce \
    --web-seed-file samples/ga4_merch_store/seeds.txt \
    --out ./bundles/ga4_merch_store
```

To iterate on a single concept, add `--concept tables/events_`. To skip
the web pass, add `--no-web`. To raise or lower the web budget, use
`--web-max-pages N` (default 100).

## What you get

A bundle under `./bundles/ga4_merch_store/` with one OKF doc per BQ
concept (dataset + tables), optionally augmented and cross-linked with
reference docs minted from the seeded GA4 documentation pages, plus an
auto-generated `index.md` at each directory level.
