# Harbor Skills — Directory Update Log

## 2026-08-18

* **Initialization.** The Harbor Skills reference layer was packaged as an OKF v0.2 knowledge bundle. Eighteen concept files across six types (Skills, Probes, Models, Templates, Doctrine, Playbooks), plus `index.md` and `log.md` and a one-file decision record (`decisions.md`, D-001..D-006). Every concept carries the trust family — `generated` (`human:harbor-ops`, 2026-08-18), `verified` (the `process:harbor-bundle-parse` structural parse, plus the human review), and `sources` (the decision record, sibling concepts, and the OKF spec). Frontmatter on every concept parses as strict YAML.
* **Subdirectories added.** `skills/`, `probes/`, `models/`, `templates/`, `doctrine/`, `playbooks/` — each groups concepts of one type. The `OKF v0.2 §3.1 reserved filenames` rule is honoured: `index.md` and `log.md` live at the bundle root with no frontmatter block (other than the `okf_version` line on `index.md`).
* **The `Skill` type proposal companion.** This bundle ships alongside `.freebuff/okf-skill-type-proposal.md` — a proposal for OKF v0.3 to recognise `type: Skill` as a conventional concept type with recommended frontmatter (the activation surface) and recommended body sections (`# Doctrine`, `# Algorithm`, `# Judge rubric`). The proposal is informative to this bundle but not required by v0.2 — Skills are valid OKF concepts under v0.2 with type values that are self-explanatory.

## 2026-08-18 — Update

* **Link fix (D-008).** Two `sources[].resource` paths — `.../skills/bootstrap.md` in `playbooks/cold-start.md` and `.../skills/decide.md` in `templates/decision-record-block.md` — corrected to `../skills/...`. The three-dot prefixes did not resolve from the referring files' directories. The seal-verifier's link phase caught both; D-008 records the invariant and the enforcement.
