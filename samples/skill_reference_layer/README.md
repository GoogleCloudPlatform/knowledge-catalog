# Sample: `skill_reference_layer` — recipe

> **Companion to the `skill_reference_layer` bundle.** This recipe explains how the bundle was produced, what it demonstrates, and how to reproduce or extend it. Drop into `knowledge-catalog/samples/skill_reference_layer/`.

## The collection behind it

The bundle is **Harbor Skills** — a fictional methodology with six Skills, four Probes, two Models, two Templates, four Doctrine, and one Playbook. The collection is generic on purpose: every methodology has shape→attack→deliver stages, an evidence discipline, an error contract, and a state curator. Harbor borrows the names of those disciplines, applies the OKF bundle shape, and proves the shape generalizes.

If you build your own collection, the recipe is the same — replace the names, keep the shape.

## What's in the bundle

```
bundle/
├── index.md                                     # Navigator (groups by type)
├── log.md                                       # History (date-stamped entries)
├── decisions.md                                 # D-NNN decision record blocks
├── skills/
│   ├── harbor-first-pass.md
│   ├── field-check.md
│   ├── search.md
│   ├── decide.md
│   ├── bootstrap.md
│   └── publish.md
├── probes/
│   ├── direction.md
│   ├── adoption.md
│   ├── threat.md
│   └── reversal.md
├── models/
│   ├── three-moments.md
│   └── workflow-shapes.md
├── templates/
│   ├── decision-record-block.md
│   └── dispatch-contract.md
├── doctrine/
│   ├── read-before-you-write.md
│   ├── provenance-is-first-class.md
│   ├── errors-name-their-fix.md
│   └── state-has-a-curator.md
└── playbooks/
    └── cold-start.md
```

Nineteen concept files plus the navigational and decision surface. The skill concepts conform to the revised Skill-type proposal: six mandatory body sections (Doctrine, Algorithm, Judge rubric, Provenance) plus two MAY sections (Common mistakes, Examples). Skip conditions fold into Algorithm step 0 rather than existing as a separate section.

## How it was produced

The bundle was authored by hand, in this order:

1. **Enumerate existing concepts.** The original Harbor body of work was the eighteen markdown concepts above — developed over a long horizon without a single structural overlay. Listing them first. (This is the "Read Before You Write" doctrine's exercise.)
2. **Classify by type.** Each concept was assigned an OKF type: `Skill`, `Probe Prompt`, `Model`, `Template`, `Doctrine`, or `Playbook`. Type values are self-explanatory; OKF §4.1 permits this.
3. **Group into subdirectories.** Subdirectories named per type for browse. Six subdirectories.
4. **Frontmatter every concept.** Each concept file got its `type`, `title`, `description`, `tags`, `status`, plus the trust family (`generated`, `verified`, `sources`).
5. **Document the trust family values.** `generated` was the author of the original concept. `verified` was a two-event list: the `process:harbor-bundle-parse` automated check + a `human:harbor-ops` review.
6. **Write the index.** Group the same concepts again, with a one-line description each. This is the entry point — a fresh agent reads `index.md` to find what it needs.
7. **Write the log.** Date-stamped, with the rationale for the restructure.
8. **Write the decisions record.** Six decisions (D-001..D-006) anchor the trust posture, the type taxonomy, the verification shape, the path-stability rule, and the rule against silent declarations.
9. **Run the parse check.** A small script verifies every concept file has parseable YAML frontmatter with non-empty `type`; the bundle's two-event verification lives in part on having this script as a `process` actor.
10. **Run the human review.** A second pass reads every concept, fixes any prose that asserts without a source, and verifies the trust family.
11. **Bundle is conformant.**

## What's reproducible

The recipe is reproducible for any methodology corpus. The smallest viable bundle has:

- One `index.md` (groups one or more concepts)
- One `log.md` (a single creation entry is enough)
- N concept files, each with parseable YAML frontmatter (`type`, `title`, `description`, `tags`, `status`) and the trust family

The first three are non-negotiable; the trust family is optional (the bundle is conformant without it, but consumers without `verified` cannot derive a trust tier).

## Body section reduction (Skill concepts)

The revised Skill-type proposal cuts the seven-section recommendation to six mandatory: `# Doctrine`, `# Algorithm`, `# Judge rubric`, `# Provenance`. (One SHOULD-mandatory: provenance was added.) `# Common mistakes` and `# Examples` are MAY - either as inlined fences in the section they exemplify, or as their own section when the skill's primary value IS the example. Skip conditions fold into `# Algorithm` step 0 rather than existing as a separate section; this sample applies the reduction so the recipe and the proposal stay aligned.

## What's not in this sample (deliberate)

- **`Attested Computation` (§10) shapes.** None of Harbor's Skills produce numbers that need attestation; adding the runtime / parameters / computation / executor / attester fields would be ceremony, not structure. A methodology corpus with computational Skills would carry the §10 fields.
- **External sources.** `sources` points at sibling concepts and `decisions.md`. The bundle does not cite external documents. A real corpus would; this is a recipe demo, not a domain statement.

## How to extend

To add a new concept:

1. Identify the OKF type. If none of the six fit, propose a new type value; OKF §4.1 says type values are not centrally registered, so producers can name them.
2. Place it in the matching subdirectory or a new subdirectory (the subdirectory name is conventional, not required).
3. Frontmatter it — `type`, `title`, `description`, `tags`, `status`, the trust family.
4. Add it to `index.md`.
5. Append a `Log` entry noting the addition.
6. Update the `decisions.md` if the addition changes the type taxonomy or the verification shape.

The `Read Before You Write` doctrine — itself part of the bundle — is the cheapest discipline for the cycle above. Reading the existing `index.md` is the missing step most contributors forget.

## License

Apache 2.0 — same as `GoogleCloudPlatform/knowledge-catalog`.

## Sources

- The Open Knowledge Format v0.2 spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- The `Skill` concept type proposal, the design partner for this recipe: see `.freebuff/okf-skill-type-proposal.md`.
- The pattern write-up for the PR description this recipe accompanies: see `.freebuff/okf-pattern-post.md`.
