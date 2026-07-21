# Proposal: Typed Relationship Edges — `supersedes` and `contested_by`

|                            |                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Status**                 | Proposed                                                                                               |
| **Pinned to**              | `okf_version: "0.1"`                                                                                    |
| **Relates to**             | #148 (typed relationships), #158 (maintenance signals), #159 (reliability object), #120 (stable ids)   |
| **Contributor**            | Andrew Crenshaw / Lexenne                                                                               |
| **Reference implementation** | Lexenne *remember* exporter — ships both keys in production; sample bundle built from public docs    |

## Summary

OKF v0.1 cross-links between concepts are untyped: `[B](../b.md)` carries no relationship and no lifecycle meaning. This proposal adds two optional frontmatter keys for cross-concept typed relationships, each with its query-time semantics written in. They differ on the one axis that drives consumer behaviour at retrieval time: **directionality**.

- `supersedes` — **asymmetric**. The carrying item replaces the referenced one. Query-time: **exclude** the superseded concept from in-force retrieval once the supersession is affirmed (see the invariant below); retain it in the bundle for lineage.
- `contested_by` — **symmetric**. The carrying item is aware of a disputing item and keeps both. Query-time: **surface-both** disputing concepts; defer adjudication to the consumer or a human. `contested_by` is canonical; `contradicts` is a back-compat spelling some producers are migrating from, and consumers SHOULD read it as an alias of `contested_by`.

Both keys are additive under §4.1 (producers MAY add keys; consumers SHOULD preserve unknown keys). Adopting them requires no core spec change; documenting them as a convention lets independent producers and consumers interoperate on typed edges rather than reinvent close-but-incompatible shapes.

This proposal is scoped to the two **lifecycle** edges. Arbitrary relationship typing (`writes_to`, `imports_from`, and similar producer-defined vocabularies, as raised in #183) is a broader problem and is deliberately out of scope here; the two can share a carrier without sharing a definition.

Both keys reference their targets by **stable concept id** per #120 — a filename-derived identifier that survives path refactoring and bundle re-organisation. Resolution events key off the same stable ids: a path move MUST NOT un-affirm a supersession or reattach it to a different incumbent.

## `supersedes`

| Field               | Value                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type                | `string` — a stable concept id, or bundle-relative filename for intra-bundle references                                                                                                                                          |
| Symmetry            | **Asymmetric.** Directional: the carrying item asserts that it replaces the referenced concept.                                                                                                                                   |
| Direction           | **Backward in time** — points to the item being replaced.                                                                                                                                                                        |
| Inverse             | **Not emitted.** Resolution keys on the forward `supersedes` only. An inverse alias (`superseded_by`) gives a producer two ways to state one relationship and a consumer two places to look, which is how a reversed edge survives review — see the production evidence from @jpavley on #148, where a prose-stated direction shipped inverted. A consumer MAY derive the reverse view internally; it is not part of the on-disk convention. |
| Query-time          | **Exclude, once affirmed.** A consumer resolving in-force state follows affirmed `supersedes` chains and drops superseded items from the live set. An unaffirmed edge (see the invariant below) leaves the incumbent in force. Superseded items remain in the bundle; they are historical, not erased. |
| Encodes a verdict?  | **Once affirmed, yes.** Until the resolution event is appended, the edge is a proposal awaiting affirmation, and the incumbent keeps governing.                                                                                    |
| Dangling reference  | Not an error. If the superseded item is absent from the bundle, the carrying item is current.                                                                                                                                     |

```yaml
supersedes: remember://lesson/lesson-corpus-est-000
```

**Load-bearing invariant — exclusion follows affirmation.** An automated writer may propose a supersession; only the appended, attributed resolution event puts it in force. Where a status axis exists, the retrieval policy reads as exclude on `status: superseded`, and status reaches `superseded` only through that event, never through a flag written onto the incumbent directly. Where no status axis exists, the affirmation still lives in the append-only resolution event, not in a timestamp. A bare `supersedes` pointer MUST NOT remove the incumbent from in-force retrieval: an unaffirmed successor cannot silently displace a live rule, and the appended resolution event stays load-bearing rather than optional.

**The closing bound and the affirmation are two carriers that meet at one timestamp.** `validity.valid_until` (#159) records *when* the incumbent stopped holding in the world, whatever the trigger — natural decay writes it, and the closing move of an affirmed supersession writes it too. The append-only, attributed resolution event records *that* the close was an affirmed supersession, who affirmed it, and a binding to the successor's stable concept id per #120. The two are never interchangeable: a consumer excludes the incumbent and lets the successor take over only on the resolution event. A closed `valid_until` with no such event is decay — the incumbent drops from in-force retrieval by temporal validity, and a still-`proposed` successor stays proposed and inherits nothing. Reading a closed window as the affirmation signal would collapse decay and affirmed supersession into one, which is the silent displacement this invariant exists to forbid.

**Where the resolution event lives — `log.md`.** For a consumer to enforce the split above, the resolution event needs a concrete, checkable home in the bundle. That home is the bundle's `log.md` — the reserved, append-only history file the spec already defines (§7). Both resolution dispositions, supersession and dismissal, write their event there: an entry dated by the `valid_until` it corresponds to, attributing the affirmation and referencing both the incumbent's and the successor's stable concept ids per #120, so the event survives a path move on either side. A producer MAY hold this history per-record internally; on export it projects to `log.md`, which is the copy a consumer reads. In the status-axis case the same affirmation is legible from `status: superseded`; where no status axis exists, `log.md` is the single instruction behind "check for a resolution event."

## `contested_by`

| Field              | Value                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type               | `string` (single id) or `string[]` (list of ids) — stable concept id(s) per #120                                                                        |
| Symmetry           | **Symmetric.** If A is `contested_by` B, B is `contested_by` A. Both sides carry the edge.                                                               |
| Direction          | Lateral — points to a co-present item that disputes this one.                                                                                            |
| Inverse            | None — the relation is its own inverse.                                                                                                                  |
| Query-time         | **Surface-both.** A consumer MUST surface every concept in the contest set. It MUST NOT resolve the edge as a verdict, collapse "contested" into "false," or drop either side without human or higher-signal input. |
| Encodes a verdict? | **No.** Records the existence of a dispute, never who is right.                                                                                          |
| Canonical name     | `contested_by`. `contradicts` is a back-compat spelling; consumers SHOULD treat it as an alias, and producers SHOULD migrate to `contested_by`.            |

```yaml
# scalar
contested_by: remember://lesson/lesson-042

# list
contested_by:
  - remember://lesson/lesson-042
  - remember://lesson/lesson-108
```

**Load-bearing invariant:** `contested_by` only earns its place if the disputed concept **stays in the bundle**. Drop it and a reader returning weeks later cannot tell a question that was settled from one that was never asked. That distinction is the whole point of the edge.

**Logical identity and mirror completeness.** Both records carry the edge — storage redundancy, so either reads standalone without a second lookup — but the *logical* edge is one thing: the sorted-endpoint triple `(min(a,b), contested_by, max(a,b))`. Consumers count and dedup on that triple, so a symmetric pair is never mistaken for two separate contests. Because the convention requires both sides to carry it, the same `symmetric` declaration also gives a validator a completeness check: if one record carries `contested_by` and its mirror does not, the standalone-readability guarantee is silently broken on one side and SHOULD be flagged. (Storage-vs-identity split contributed by @jpavley on #148.)

## Resolution semantics — three states, append-only

A consumer reads a concept's dispute state from the edges alone, without an adjudication engine shipped. There are exactly three states, distinguished by what is present in the bundle. No record is ever edited; every resolution is a new append.

**State 1 — never questioned.** No `contested_by`; not referenced by any `supersedes`. Settled by default: current, uncontested, stable. Absence of an edge means "no dispute asserted," not "proven undisputed."

**State 2 — contested and open.** A `contested_by` edge exists, both records are present and carry no closed `validity.valid_until`, and no `supersedes` has been appended resolving the contest. A consumer surface-both with the contest visible; it MUST NOT call a winner from the edge alone.

**Pending supersession (a proposal, not a settled state).** A `supersedes` edge whose resolution event has not been appended marks a *proposed* displacement: both items surface, the incumbent remains in force, and the successor reads as lineage-in-waiting. The exclude semantics attach at affirmation, per the invariant above.

**State 3 — contested and settled.** A resolution has been appended, not edited into either record. The `contested_by` edge is retained regardless of disposition so a settled contest stays distinguishable from one never raised.

Two settlement dispositions:

- **Supersession.** The winning concept gains a `supersedes` edge to the losing concept; the losing concept's `validity.valid_until` closes. Both records retain `contested_by` — the edge is symmetric and retained regardless of disposition, so the winner carries it too, marking that this concept emerged from a contest rather than as an uncontested replacement. `supersedes` and `contested_by` encode different facts and co-exist on the winner: the first says it won and the loser is out of force, the second is the contest provenance. Query-time: exclude the loser from the live set. The closing bound (`valid_until`) records when; the appended, attributed resolution event, written to the bundle's `log.md`, records that the close was an affirmed supersession and binds it to the winner's stable concept id per #120. Exclusion of the loser and promotion of the winner key on that `log.md` event, never on the closed `valid_until` alone. Open versus settled is read from `valid_until` plus the `log.md` event, not from the presence of `contested_by`.
- **Dismissal.** The contest is judged without supersession — one side is dismissed as not a genuine dispute. No `supersedes` edge; the dismissed concept's `validity.valid_until` closes; a resolution receipt in `log.md` carries attribution. The `contested_by` edge remains on both records.

## Composition with the status axis

The affirmation-status axis (`proposed | accepted | superseded | deprecated`, per @inkxel's #148 spelling; automated writers mechanically capped at `proposed`) composes with both edges cleanly, and the invariant above is the joint. Superseding an already-accepted concept is an append: the successor enters as `proposed` carrying the `supersedes` edge, and affirming the successor is what appends the resolution event to the incumbent, whose status reaches `superseded` only as a side effect of that affirmation. The incumbent is never edited directly, so the writer cap survives composition. The dismissal disposition is a resolution event, not a status value. Resolution state and status are orthogonal axes; a concept has a value on each.

## Relationship to adjacent proposals

- **#159 (reliability object).** Reliability grades a claim *within* a concept (`confidence`, `basis`, `validity`). These edges relate *whole concepts* to each other. The two do not overlap: an item can carry a reliability object and a `supersedes` edge at once. The reliability object's `validity.valid_until` is the closing-bound carrier these edges compose with; it records when an item stopped holding, while the append-only resolution event carries whether that close was an affirmed supersession (see the invariant above).
- **#158 (maintenance signals).** These edges are the cross-concept half of the maintenance surface; freshness and confidence are the intra-concept half and defer to #97 and #159 respectively.
- **#120 (stable ids).** Both edges and their resolution events target stable concept ids, so a path move cannot un-affirm or misattribute a supersession.
- **#183 (arbitrary typed links).** A broader `links:` carrier for producer-defined relations can host these two edges without redefining them; the query-time semantics attach to the relation, not the syntax.

## Sample bundle

Exercises all three resolution states. Concept ids are stable per #120.

**State 1 — never questioned:**

```yaml
# okf-is-the-paper-a1b2c3d4.md
type: Reference
resource: remember://lesson/lesson-a1b2c3d4
# no contested_by, not superseded -> State 1
```

**State 2 — contested and open:**

```yaml
# curation-in-the-producer-b2c3d4e5.md
type: Method
resource: remember://lesson/lesson-b2c3d4e5
contested_by: remember://lesson/lesson-c3d4e5f6

# curation-in-the-format-c3d4e5f6.md
type: Method
resource: remember://lesson/lesson-c3d4e5f6
contested_by: remember://lesson/lesson-b2c3d4e5
# both live, no closed valid_until, no supersedes -> surface-both
```

**State 3 — contested and settled (supersession):**

```yaml
# measured-corpus-utilization-d4e5f6a7.md  (winner)
type: Claim
resource: remember://lesson/lesson-d4e5f6a7
supersedes: remember://lesson/lesson-e5f6a7b8
contested_by: remember://lesson/lesson-e5f6a7b8
# winner retains contested_by (symmetric, retained regardless of disposition):
# it marks that this concept emerged from a contest. supersedes says it won and
# the loser is out of force; the two edges encode different facts and co-exist.

# one-percent-corpus-est-e5f6a7b8.md  (superseded)
type: Claim
resource: remember://lesson/lesson-e5f6a7b8
reliability:
  validity:
    valid_until: 2026-06-25T00:00:00Z   # closing bound (#159): when it stopped holding
contested_by: remember://lesson/lesson-d4e5f6a7
# valid_until records WHEN the window closed; the append-only resolution event
# (log.md) records THAT it was an affirmed supersession and binds it to the
# winner's stable id. contested_by retained append-only; exclude from live set.
```

## Lint affordances

Each edge declares a **directionality** — `supersedes` is asymmetric, `contested_by` is symmetric — and that single declaration is enough for a validator to run three checks with no lifecycle-specific knowledge. The general form is @jpavley's, drawn from a production civic-records vocabulary on #148; these two edges slot into it as ordinary entries.

1. **Closed vocabulary.** An edge verb outside the registered set warns. This is what makes the other two checks meaningful.
2. **Asymmetric contradiction.** For `supersedes`, both `A supersedes B` and `B supersedes A` present is a flag. The validator cannot know which direction is correct, but it refuses to let the pair pass silently; the same check extends to a cycle in a supersession chain.
3. **Symmetric identity + mirror completeness.** For `contested_by`, endpoints normalize to the sorted triple so a pair is one logical edge, and a missing mirror is flagged (per the completeness note above).

One thing the declaration cannot check is **semantic direction**: whether a specific, well-formed `supersedes` edge happens to point the right way. That stays a human or agent review step — a convention that implied otherwise would oversell what typing buys. The mitigation is advisory (emit asymmetric edges grouped by verb as a review sheet), which keeps the guarantee the lint *does* give precise: each edge has exactly one place to be wrong.

## Conformance

Both keys are optional and additive. A bundle carrying them remains valid under §9 (parseable frontmatter, non-empty `type`). A consumer that does not recognise the keys preserves them on round-trip per §4.1 and treats the referenced concepts as ordinary linked items. A typed-aware consumer applies the query-time semantics above.

Contributed under Apache 2.0, from the team building *remember* at Lexenne.
