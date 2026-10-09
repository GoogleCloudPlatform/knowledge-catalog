---
name: organizing-with-okf
description: Use when creating, organizing, or restructuring project folders, knowledge bases, notes, catalogs, or documentation directories — or when the user mentions OKF, knowledge bundles, concept documents, or asks how to structure a directory of markdown knowledge.
---

# Organizing Folders and Projects with OKF

## Overview

OKF (Open Knowledge Format) represents knowledge as **plain markdown files with YAML frontmatter in a directory tree** (a *bundle*). No SDK, no registry, no tooling required — readable by humans, parseable by agents, diffable in git.

Full spec: `okf/SPEC.md` at this repository's root (OKF v0.1). Read it for edge cases; the essentials are below. **Do not invent conventions beyond this page or the spec.**

## When to Use

- Setting up or restructuring a projects/knowledge/docs directory
- Cataloging assets (tables, APIs, services, repos) or abstract ideas (metrics, playbooks, decisions)
- User asks to "organize my folders/projects" in a durable, agent-readable way

**Not for:** source code layout inside an app, or replacing domain schemas (OpenAPI, Avro) — OKF *references* those.

## Bundle Structure

```
bundle-root/
├── index.md          # reserved: directory listing (progressive disclosure)
├── log.md            # reserved, optional: change history
├── <concept>.md      # concept docs at any level
└── <group>/          # subdirectories group concepts (e.g. projects/, areas/, references/)
    ├── index.md
    └── <concept>.md
```

Concept ID = file path minus `.md` (`projects/elara.md` → `projects/elara`). Organize directories however fits the domain; for personal organization, `projects/`, `areas/`, `references/`, `playbooks/` work well.

## Concept Document Template

Every non-reserved `.md` file MUST have frontmatter with a non-empty `type`:

```markdown
---
type: Project                    # REQUIRED. Descriptive, free-form (Project, Playbook, Reference, Metric, …)
title: Elara                     # recommended
description: One-sentence summary used by indexes and search.
resource: https://github.com/x/elara   # only if a canonical asset exists
tags: [web, active]
timestamp: 2026-07-17T00:00:00Z  # ISO 8601, last meaningful change
---

Body is free markdown. Prefer structure (headings, tables, lists) over prose.
Link concepts with normal markdown links, bundle-relative from root:
Depends on the [OKF spec](/references/okf.md).

# Citations
[1] [External source backing a claim](https://example.com)
```

- **Do not** invent frontmatter keys like `id`, `status`, `links`, `created`/`updated` — extra keys are allowed but relationships belong in the **body as markdown links**, not frontmatter.
- Conventional body headings when applicable: `# Schema`, `# Examples`, `# Citations`.
- `resource` accepts any URI that canonically identifies the asset — an https URL, or a local absolute path for local repos/dirs. Omit for abstract concepts.
- `timestamp` at date-only precision (`T00:00:00Z`) is fine.

## Reserved Files

**`index.md`** — NO frontmatter (exception: bundle root may carry only `okf_version: "0.1"`). Bullet lists grouped under headings, each entry reusing the concept's description. Entry links are relative to the index's own directory (so `projects/index.md` links `elara.md`, root index links `projects/elara.md`):

```markdown
# Projects
* [Elara](projects/elara.md) - Web app for …
* [OKF](projects/okf.md) - Spec repo for the Open Knowledge Format.
```

Per-directory indexes are optional; add one when a directory has 3+ concepts or subdirectories.

**`log.md`** — newest-first, ISO date headings, bold action word per entry, bundle-relative links. One root `log.md` suffices for small bundles; per-directory logs only for large ones:

```markdown
# Update Log
## 2026-07-17
* **Creation**: Added [Elara](/projects/elara.md) concept.
```

## Conformance Checklist

Before finishing, verify:
- [ ] Every concept file has parseable YAML frontmatter with non-empty `type`
- [ ] `index.md` files have no frontmatter and use `* [Title](url) - description` entries
- [ ] Log entries (if any) live in `log.md`, dated `YYYY-MM-DD`, newest first
- [ ] Cross-links are markdown links, preferably bundle-relative (`/dir/concept.md`)
- [ ] No invented required fields; unknown data goes in extra frontmatter keys or the body

## Visualizing a Bundle

This repository ships a native graph viewer. From the `okf/` directory, run `.venv/bin/python -m reference_agent visualize --bundle <bundle-dir>` to write a self-contained `viz.html` (force-directed concept graph, backlinks, search). If `.venv` is missing, create it first per `okf/README.md`: `python3.13 -m venv .venv && .venv/bin/pip install -e .`. Offer it when the user wants to see a bundle as a graph.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Frontmatter in `index.md` | Index files are plain listings (root may have `okf_version` only) |
| `log/updates.md`, `CHANGELOG.md` | Reserved name is `log.md`, at any directory level |
| Relationships as frontmatter `links:` | Express them as markdown links in the body |
| Missing `description` | Add it — indexes and search snippets depend on it |
| Rejecting unknown types/keys/broken links | Consumers must tolerate them; broken links = not-yet-written knowledge |
