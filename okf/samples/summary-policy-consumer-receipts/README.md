# Summary policy consumer receipt fixtures

These fixtures are tiny, deterministic examples for testing whether an OKF
consumer preserved the load-bearing meaning declared by a concept's
`summary_policy` frontmatter.

Each case contains:

- `concept.md` — an OKF concept with stable `required_assertions` and
  `forbidden_compressions` IDs.
- `good-summary.md` — a transformed summary that should pass.
- `bad-summary.md` — a transformed summary that should fail.
- `expected.yaml` — the expected consumer receipt for both summaries.

The receipt does not try to decide truth in the world. It only checks whether a
consumer preserved the source concept's declared policy during summarization.
This keeps OKF source-side and consumer-agnostic while making summary policy
conformance testable.
