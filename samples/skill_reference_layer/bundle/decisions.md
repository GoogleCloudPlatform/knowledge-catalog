---
type: Decision Record
title: "Harbor Skills Decisions"
description: "The Harbor Skills decision record — inline decision-record blocks (D-001..D-006), each with context, target boundary, and machine-enforceable invariant."
tags: [decisions, harbor]
status: stable
generated: { by: human:harbor-ops, at: 2026-08-18 }
verified:
  - { by: process:harbor-bundle-parse, at: 2026-08-18 }
  - { by: human:harbor-ops, at: 2026-08-18 }
sources:
  - id: harbor-collaboration
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: "OKF v0.2 — Decision-records are a producer-side arrangement; this bundle's pattern is one of many"
---

# Harbor Skills — Decisions (D-001 .. D-006)

**Single-file decision record.** Six fictional decisions for the Harbor Skills collection, kept as inline decision record blocks in one document. Each block has the four keys the OKF Decision record shape recommends: `id` + `status`, `context & trade-offs`, `target boundary`, `machine-enforceable invariant`. The bundle's `sources` on every concept points back to this file.

---

#### D-001 · Adopt OKF v0.2 for the reference layer — **Accepted**

- **context & trade-offs.** Reference-layer markdown was previously distributed as plain concepts without frontmatter, an index, or a log. Producers had their own conventions and consumers couldn't derive provenance. v0.2 makes frontmatter (`type`, `title`, `description`, `tags`, `status`) and the trust family (`generated`, `verified`, `sources`) standard, with `index.md` / `log.md` as the conventional surface.
- **target boundary.** every concept file under `bundle/` — formatted as OKF v0.2 with strict YAML frontmatter, the trust family, and a `sources` list pointing at sibling concepts and this decision record.
- **machine-enforceable invariant.** every concept file (except `index.md` and `log.md`) has parseable YAML frontmatter with a non-empty `type`; every reserved filename follows §8 / §9; the bundle root `index.md` carries `okf_version: 0.2`.

#### D-002 · Bundle the prose as inline decision record blocks in one document — **Accepted**

- **context & trade-offs.** A directory of decision files grew over time and started to drift (paths renamed, files orphaned). Inline decision record blocks in one file survive all renames and keep the audit trail on one page.
- **target boundary.** `bundle/decisions.md` is the only decision-record file in the bundle. New decisions append, never relocate historical ones.
- **machine-enforceable invariant.** only `decisions.md` carries `D-NNN` decision record blocks. Subdirectories do not introduce their own decision-record files.

#### D-003 · Six OKF concept types, not a fixed taxonomy — **Accepted**

- **context & trade-offs.** OKF v0.2 §4.1 says type values are not centrally registered. Producers SHOULD pick self-explanatory values. A fixed taxonomy (`Skill`, `Probe Prompt`, etc.) would help consumers that filter on type; the values used here match the conventional vocabulary this sample proposes to OKF.
- **target boundary.** type values present in this bundle: `Skill`, `Probe Prompt`, `Model`, `Template`, `Doctrine`, `Playbook`. New types may be added with rationale in this file; consumers must tolerate unknown values.
- **machine-enforceable invariant.** every concept file's `type` is one of the six values listed above; new types append to this list.

#### D-004 · Two-event verification on every concept — **Accepted**

- **context & trade-offs.** Six trust tiers map onto `verified`-list-derivation in OKF §5.3. Single-event verification leaves gaps (a process self-test alone is `machine-confirmed` — fine for noun-only artefacts, weak for methodology claims). Two-event verification — an automated parse plus a human review — lands every concept at `human-reviewed` cleanly.
- **target boundary.** the `verified` field on every concept is a list with two entries: a `process:` actor (this bundle uses `process:harbor-bundle-parse`) followed by a `human:` actor (this bundle uses `human:harbor-ops`).
- **machine-enforceable invariant.** every `verified` list contains at least two entries; at least one is `process:`-prefixed; at least one is `human:`-prefixed.

#### D-005 · Subdirectories group by type, paths stay stable — **Accepted**

- **context & trade-offs.** the skills that activate this bundle reference concepts by path. Moving a concept to a new subdirectory would break the activation surface. Subdirectories are useful for readability; renaming them is not.
- **target boundary.** six type-grouped subdirectories named `skills/`, `probes/`, `models/`, `templates/`, `doctrine/`, `playbooks/`. Files within operate under their subdirectory's group; cross-references use intra-bundle relative paths.
- **machine-enforceable invariant.** every path listed in `index.md` resolves to an existing file under `bundle/`; every `sources[].resource` that points inside the bundle is relative to the bundle root and resolves.

#### D-006 · No new copy-pasteable blocks without provenance — **Accepted**

- **context & trade-offs.** every methodology claim is a `Skill`, `Probe Prompt`, `Model`, or `Doctrine` that can be cited from another concept's `sources[]` entry. Plain-prose assertions in markdown without a concept file do not carry the trust family and should not be used as authoritative.
- **target boundary.** every claim in this bundle is anchored to a concept file (or to a decision record block in `decisions.md`). A claim that isn't anchored either moves into a concept file (the right move) or is dropped (always acceptable — silence is better than anonymous authority).
- **machine-enforceable invariant.** a body paragraph that asserts "we always do X" without naming the concept file or decision record is rejected at review (D-006).

---

#### D-007 · Align the sample with the Skill-type proposal revision - **Accepted**

- **context & trade-offs.** The companion `OKF v0.3 Skill concept type` proposal was revised after a real-world seal of twelve SKILL.md files shipped against the proposed shape. Five concrete changes (drop skip conditions as a top-level section, downgrade common mistakes to MAY, drop examples as a section, tighten `verified.process` to structural-only, sharpen the Playbook vs Skill distinction by routing) - this sample carries the changes forward so the recipe and the proposal stay aligned.
- **target boundary.** every concept file under `bundle/skills/` removes its `## Skip conditions` section; the skip content folds into Algorithm step 0. The proposal's revision keyword for navigation is `OKF as-is` for the reference layer - the bundle already conforms.
- **machine-enforceable invariant.** a `## Skip conditions` section does not appear in any skill file under `bundle/skills/`; every skill file's `# Algorithm` carries step 0 with the folded skip content.

## Provenance

This decision record is the analog of an ADR archive. Its draft form is OKF-true (`generated` and `verified` fields are optional on `index.md` beyond `okf_version`; this file is a normal concept-equivalent and could carry the trust family if it were a concept). Consumers of the bundle should still treat decision record blocks as the authoritative decision surface — `sources` on every concept points here, not the other way around.
