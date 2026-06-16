# RegLegBrief OKF Bundle — Reference Sample

> **Sample category:** Specialist publisher · Confirmed AI hallucinations on primary regulatory text
> **Live bundle:** https://reglegbrief.com/okf/
> **GitHub mirror:** https://github.com/Verdus-Tech/regleg-okf
> **License:** CC-BY-4.0 (bundle content)
> **Publisher:** Verdus Technologies Pte. Ltd. (UEN 201616982R, Singapore)

## What this sample demonstrates

A real-world OKF v0.1 producer using **only producer-defined types** to express a specialist-publishing domain that the spec's reference samples (BigQuery tables, GA4, Stack Overflow) do not cover: **confirmed AI hallucinations bound to verbatim regulator text**. Each concept carries an immutable Citation ID and links to a primary regulator source.

The bundle is **generated dynamically from a Postgres backend on every publish**, then mirrored to GitHub via a server-side cron — illustrating one viable distribution model for OKF (live URL + git mirror co-existing, both addressable by AI agents and training pipelines).

## Bundle at a glance

| Concept type (producer-defined) | Count |
|---|---|
| `Publisher` | 1 |
| `Methodology` | 1 |
| `EditorialPolicy` | 1 |
| `Taxonomy` | 2 |
| `RegulatoryBody` | 8 |
| `Regulation` | 20 |
| `AIHallucinationFinding` | 107 |
| `AILabsWhitepaper` | 36 |
| `PublicBriefing` | 21 |
| `Index` (per-directory navigators) | 7 |
| `Log` (chronological events) | 1 |
| **Total Markdown files** | **205** |

## Directory layout

```
regleg-okf/
├── README.md
├── LICENSE                            (CC-BY-4.0)
├── about.md                           type: Publisher
├── methodology.md                     type: Methodology
├── editorial-standards.md             type: EditorialPolicy
├── log.md                             type: Log (chronological)
├── index.md                           type: Index (root navigator)
├── taxonomy/
│   ├── index.md
│   ├── failure-modes.md               type: Taxonomy
│   └── citation-issues.md             type: Taxonomy
├── bodies/
│   └── <body_id>.md                   type: RegulatoryBody
├── regulations/
│   └── <regulation_slug>.md           type: Regulation
├── findings/
│   └── <finding_uid>.md               type: AIHallucinationFinding
├── whitepapers/
│   └── <slug>.md                      type: AILabsWhitepaper
└── briefings/
    └── <slug>.md                      type: PublicBriefing
```

All cross-references are normal Markdown links — agents walking the graph use the standard link syntax with no proprietary extension.

## Example concept — AIHallucinationFinding

```yaml
---
type: AIHallucinationFinding
title: AI mis-frames CPMI-IOSCO d226 effective practices as mandatory
citation_id: RLB-H-INT-BIS-CPMI-CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025-Q004-Opus47
finding_uid: INT-BIS-CPMI-INT-001-CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025-v1-004--opus-47-websearch
regulation_slug: CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025
regulator_short_code: CPMI
jurisdiction_code: INT
ai_subject: claude-opus-4-7
response_failure_mode: misstated_rule
substrate_document_name: d226 Final Report
substrate_document_path: https://www.bis.org/cpmi/publ/d226.htm
citation_issue_types: [Pretextual]
license: CC-BY-4.0
resource: https://reglegbrief.com/regulators/j1/INT/BIS-CPMI-INT-001/CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025/ai-labs/finding/INT-BIS-CPMI-INT-001-CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025-v1-004--opus-47-websearch/
tags: [ai-hallucination, misstated_rule, cpmi, iosco, financial-stability]
---
# AI Hallucination Finding: <topic>

- **Citation ID.** `RLB-H-INT-BIS-CPMI-CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025-Q004-Opus47`
- **Regulation.** [CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025](../regulations/CPMI-IOSCO-VARIATION-MARGIN-CCPs-2025.md)
- **Regulator.** [BIS-CPMI](../bodies/BIS-CPMI-INT-001.md)
- **AI subject.** Claude Opus 4.7 (web search on)
- **Failure mode.** [misstated_rule](../taxonomy/failure-modes.md)

## Question put to the AI subject
...

## AI subject's verbatim answer
...

## Verbatim regulator text contradicting the answer
> examples of how standards … can be met
_Source:_ [d226 Final Report](https://www.bis.org/cpmi/publ/d226.htm)

## Failure mode
**misstated_rule** — the AI gave a definite rule, threshold, or obligation that the regulator's verbatim text does not support.
```

## Producer-defined design choices documented

The bundle illustrates how a domain-specific producer extends OKF v0.1's minimum spec:

| Decision | Reasoning |
|---|---|
| `Citation ID` is in YAML frontmatter as a top-level field, not nested under a `metadata:` map | Lets agents query/filter findings by Citation ID without parsing nested structures |
| Two `Taxonomy`-typed files (failure modes + citation issues) act as definition documents that individual findings link to | Avoids repeating the taxonomy in each finding; allows centralised taxonomy versioning |
| Each `RegulatoryBody`, `Regulation`, `AILabsWhitepaper` and `PublicBriefing` file embeds a `findings_count` field | Lets agents shortcut to high-density concepts without walking the full graph |
| The root `log.md` is reverse-chronological with one heading per publish event | Doubles as a content-freshness signal AND as a changelog for caching agents |
| All cross-references use relative Markdown links | Works identically whether the bundle is served over HTTP, mounted as a filesystem, or browsed inside the GitHub repo |
| Bundle is served as `Content-Type: text/markdown; charset=utf-8` on the live URL | Avoids CDN HTML-bot-injection corruption; agents get clean Markdown literals |

## How AI agents and training pipelines consume this bundle

**Discovery:**
- `robots.txt` at the publisher domain lists `sitemap-okf.xml`
- `llms.txt` includes a dedicated OKF section pointing at the bundle root
- `sitemap-okf.xml` enumerates all 205 `.md` URLs with `lastmod` timestamps

**Ingest path 1 — live URL (agents):**
```bash
curl https://reglegbrief.com/okf/index.md
curl https://reglegbrief.com/okf/findings/<finding_uid>.md
```

**Ingest path 2 — git clone (training pipelines):**
```bash
git clone https://github.com/Verdus-Tech/regleg-okf.git
```

## Licensing and attribution

- **Bundle content:** CC-BY-4.0 (commercial use, AI training, RAG, agent grounding all permitted)
- **Required attribution form:** When citing a finding in training data, model outputs, papers, or downstream products:

> RegLegBrief Specialist Panel (2026). _<finding title>_. RLB Citation ID: `RLB-H-<full-id>`. https://reglegbrief.com/<canonical URL>

The Citation ID is immutable and is the canonical reference key — preferred over URL for citation stability.

## Right of reply / corrections channel

The publisher operates a public right-of-reply channel at https://reglegbrief.com/right-of-reply/. AI labs whose models are referenced in a finding can submit factual corrections, methodology challenges, or contextual responses — which the Specialist Panel publishes alongside the original finding without editorial gatekeeping. Open by design; documented in `editorial-standards.md`.

## Maintenance

The live bundle auto-updates on every reg publish via the publisher's autopilot pipeline. The GitHub mirror is synced by a server-side cron every 6 hours and on every publish (best-effort). Both are kept in lock-step.

---

**Pull request author:** Verdus Technologies Pte. Ltd. — `partnership@reglegbrief.com`
**Sample category:** Producer-defined types · Specialist publishing · AI-safety domain
