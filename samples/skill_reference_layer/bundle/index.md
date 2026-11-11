---
okf_version: 0.2
---
# Harbor Skills — the reference bundle (OKF)

This directory is an **Open Knowledge Format (OKF) knowledge bundle**: a directory of markdown concepts, each carrying YAML frontmatter (`type`, `title`, `description`, `tags`, `status`) and the trust family (`generated`, `verified`, `sources`). It groups the methodology behind the fictional **Harbor Skills** collection — Skills, Probes, Models, Templates, Doctrine, and Playbooks — as one traversable knowledge graph.

The bundle stays a bundle because paths are stable. Subdirectories group concepts by type for readability; every file is reachable from this index by relative link.

## Skills — the activation surface

* [Harbor First Pass](skills/harbor-first-pass.md) — entry-point skill that routes by intent to one of the below
* [Field Check](skills/field-check.md) — connectivity probe: TCP / DNS / HTTP HEAD, single go / no-go verdict
* [Search](skills/search.md) — federated web search across keyless engines, evidence-ledger output
* [Decide](skills/decide.md) — turn raw material into named decisions with rationale, owner, clock
* [Bootstrap](skills/bootstrap.md) — stand up a fresh context for a cold-start task; carries the cold-start protocol
* [Publish](skills/publish.md) — gate + ship: typecheck, tests, lint, story, deploy

## Probes — the job descriptions

* [Direction Probe](probes/direction.md) — orient probe: is this still the right thing, the right shape?
* [Adoption Probe](probes/adoption.md) — what should we adopt? KEEP / FORK / MINE / IGNORE-classify
* [Threat Probe](probes/threat.md) — STRIDE threat model: attack surface, hardening tickets, named elephants
* [Reversal Probe](probes/reversal.md) — undo / migrate / exit story, every step a ticket or a paragraph

## Models — how the collection thinks

* [Three Moments](models/three-moments.md) — Shape → Build → Deliver as the operating cadence
* [Workflow Shapes](models/workflow-shapes.md) — fan-out / pipeline / loop / judge vocabulary

## Templates — schemas consumers fill

* [Decision Record Block](templates/decision-record-block.md) — the four-key pattern (`D-NNN`, status, context, boundary, invariant)
* [Dispatch Contract](templates/dispatch-contract.md) — what every ticket carries to its company

## Doctrine — the rules the writer holds

* [Read Before You Write](doctrine/read-before-you-write.md) — a consumer reads the existing artifact before adding a sibling
* [Provenance Is The First-Class Citizen](doctrine/provenance-is-first-class.md) — every claim cites a source; without one, it is a guess
* [Errors Name Their Fix](doctrine/errors-name-their-fix.md) — every FAIL line names violation + the fix + where to look
* [State Has a Curator](doctrine/state-has-a-curator.md) — durable state names an owner or it rots
* [Restate, Then Investigate](doctrine/restate-before-investigate.md) — the candidate is restated in plain language before investigation
* [Cost-Shaped Budget](doctrine/cost-shaped-budget.md) — every dispatch carries its tool budget; the totals are reviewed before commitment

## Playbooks — procedural references

* [Cold Start Playbook](playbooks/cold-start.md) — what the bootstrap skill executes at the entry of a task

## Bundled registries

* [Decisions](decisions.md) — the inline decision record (D-001..D-006)
* [Log](log.md) — the directory's history
