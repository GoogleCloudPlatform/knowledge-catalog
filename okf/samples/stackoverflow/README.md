# Stack Overflow public dataset sample

Runs the enrichment agent against the public
`bigquery-public-data.stackoverflow` dataset (a mirror of the Stack
Exchange Data Dump for Stack Overflow — `posts_questions`,
`posts_answers`, `users`, `votes`, `comments`, `badges`, `tags`,
`post_history`, `post_links`, ...) and seeds the web pass with the
canonical schema references maintained by the Stack Exchange community.

This sample contrasts with the GA4 sample by exercising **multi-concept
enrichment**: a single schema-docs page typically describes several tables
(`posts_questions` + `posts_answers` + `users`), so the web agent often
updates more than one concept per fetched page.

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
  query bytes. The `stackoverflow` tables are large — keep
  `--web-max-pages` modest while iterating.
- Gemini credentials — either `GEMINI_API_KEY` (AI Studio) **or** Vertex
  AI (`GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=<id>`,
  `GOOGLE_CLOUD_LOCATION=<region>`).

## Run

```
.venv/bin/python -m enrichment_agent enrich \
    --source bq \
    --dataset bigquery-public-data.stackoverflow \
    --web-seed-file samples/stackoverflow/seeds.txt \
    --out ./bundles/stackoverflow
```

To iterate on a single concept, add `--concept tables/posts_questions`.
To skip the web pass, add `--no-web`. To raise or lower the web budget,
use `--web-max-pages N` (default 100).

## What you get

A bundle under `./bundles/stackoverflow/` with one OKF doc per BQ concept
(dataset + each table), augmented and cross-linked with reference docs
minted from the seeded Stack Exchange schema pages, plus an
auto-generated `index.md` at each directory level.
