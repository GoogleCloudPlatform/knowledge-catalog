---
type: source
title: Cricsheet — CC BY 3.0 Open Cricket Data
description: Open ball-by-ball cricket match data. Primary open-data source for IPL historical (2007/08–2025) and Major League Cricket (MLC 2023–2025) in the CricketStudio OKF bundle. License — Creative Commons Attribution 3.0 (CC BY 3.0).
status: active
last_verified: 2026-06-22
license: CC-BY-3.0
source_system: Cricsheet
source_boundary: public_open_data
entity_id: example:source:cricsheet
resource: https://cricsheet.org
canonical_page: https://cricsheet.org
tags:
  - cricket
  - source
  - open-data
  - cricsheet
---

## What Is Cricsheet?

[Cricsheet](https://cricsheet.org) is an open cricket data project that publishes ball-by-ball data for international and domestic cricket matches in YAML and JSON formats. It is the primary open-data source for cricket analytics.

## License

**Creative Commons Attribution 3.0 Unported (CC BY 3.0)**

You are free to:
- Share — copy and redistribute the material in any medium or format
- Adapt — remix, transform, and build upon the material for any purpose

Under the following terms:
- **Attribution** — You must give appropriate credit to Cricsheet (https://cricsheet.org) and the data contributors.

Full license: https://creativecommons.org/licenses/by/3.0/

## Attribution Requirement

When publishing OKF files derived from Cricsheet data, include attribution in the provenance field:

```yaml
provenance:
  source: Cricsheet CC BY 3.0 · [competition] · [N] matches · [snapshot date]
```

And in any published document or dataset README:

> Ball-by-ball data from Cricsheet (https://cricsheet.org), CC BY 3.0.

## What Is Included

Cricsheet publishes data for (among others):
- Indian Premier League (IPL) — historical seasons
- Major League Cricket (MLC) — 2023, 2024, 2025
- T20 Internationals
- ODI Internationals
- Test matches
- Various domestic T20 leagues

Coverage varies by competition and season. Check cricsheet.org for current coverage.

## What Is NOT Included

- Live or real-time ball-by-ball data
- Current-season data before Cricsheet publishes it
- Full BCCI-licensed IPL 2026 data (the current season may not be on Cricsheet yet)

## Allowed Use in OKF Bundles

- Publish derived claims (aggregated statistics, rankings, averages) with attribution.
- Link to Cricsheet as the source.
- Include metadata and methodology derived from the data.

**Do not:**
- Reproduce raw Cricsheet YAML/JSON files verbatim in the OKF bundle without checking current Cricsheet terms.
- Claim data as your own without attribution.
- Use Cricsheet data to imply endorsement by Cricsheet.

## Source Boundary Declaration

Files derived from Cricsheet must use:

```yaml
source_boundary: public_open_data
license: CC-BY-3.0
```

## Related

- [Cricsheet website](https://cricsheet.org)
- [CC BY 3.0 license](https://creativecommons.org/licenses/by/3.0/)
