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

## Observed cases

Each fixture in this set is mapped from a documented, publicly citable
summarization event rather than a constructed example. The `concept.md` for
each case cites its public source and states the observation boundary — what
was observed, on which surface, and where the record lives. The fixtures
remain fully deterministic: the observed event supplies the case's provenance,
but the test itself checks only the declared assertion and compression IDs
against the two summaries. Nothing in the runner depends on the external
record.

The `author`, `orcid`, and source URLs in each `concept.md` serve as
observation-boundary markers anchoring each fixture to its public
record. Each
provenance section cites the specific observation record, not a registry
as a whole.

| Case | Failure mode | Observation record |
|---|---|---|
| `semantic-inversion/` | A cited source's declared X-not-Y position inverted into the reading it excludes | [alexanarch.org/s/records/1054/](https://www.alexanarch.org/s/records/1054/) |
| `entity-substitution/` | A specific authored genre absorbed into the generic category it names, on the authority of its own cited sources | Machine Mediation Capture Registry, entry `metadata-packet-ai-indexing` (2026-06-13) |
| `provenance-erasure/` | An authored instrument absorbed as unattributed generic knowledge, attribution and identifier stripped | [alexanarch.org/s/records/198/](https://www.alexanarch.org/s/records/198/) |
