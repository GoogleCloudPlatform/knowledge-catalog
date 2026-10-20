# Cricket Domain Example Bundle for Google OKF

This directory contains a standalone cricket domain example bundle demonstrating the Cricket OKF profile on top of [Google Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

## What this bundle demonstrates

- A **cricket type vocabulary** extending Google OKF's open `type` system with 20 cricket-specific values
- A **provenance convention** adding source traceability, license declaration, and freshness fields that Google OKF v0.1 leaves undefined
- A **sample-size doctrine** defining minimum data thresholds before cricket rankings are valid
- **Metric definition files** (batting strike rate, bowling economy, death-overs economy) showing the standard format for citable cricket metrics
- **Entity files** (player, team, venue) with canonical URLs, external IDs, and relationship links
- A **dossier file** showing a verified Q&A pattern for AI agents
- A **story file** showing the narrative layer format — provenance-backed cricket narrative with scope, sample size, and stated limitations

## File Structure

```
examples/cricket/
├── README.md
├── index.md                         # Bundle overview
├── spec/
│   ├── types.md                     # Cricket type vocabulary (20 types)
│   ├── provenance.md                # Provenance convention
│   └── sample-size.md              # Sample-size doctrine
├── metrics/
│   ├── batting-strike-rate.md       # Metric definition
│   ├── bowling-economy.md           # Metric definition
│   └── death-overs-economy.md      # Phase metric definition
├── players/
│   └── example-t20-batter.md       # Annotated example player entity
├── teams/
│   └── example-t20-team.md         # Annotated example team entity
├── venues/
│   └── example-cricket-ground.md   # Annotated example venue entity
├── dossier/
│   └── example-agent-pattern.md    # Verified Q&A pattern for agents
├── stories/
│   └── example-cricket-story.md    # Annotated example story (narrative layer)
└── sources/
    └── cricsheet.md                 # Open data source declaration (CC BY 3.0)
```

## Live Reference Implementation

The full CricketStudio OKF bundle at **https://okf.cricketstudio.ai** is a CI-validated, 430+ file implementation of this profile, including:
- 65 IPL player profiles with phase splits (powerplay / middle / death)
- 10 metric definitions
- 37 dossier Q&A patterns
- 5 provenance-backed cricket stories (Journeys)
- 8 research reports

GitHub: https://github.com/i-m-arul/cricketstudio-okf

## License

- `spec/`, `metrics/`, `dossier/`, `stories/`, `README.md`, `index.md` — CC-BY-4.0
- `sources/cricsheet.md` — documents data licensed CC BY 3.0 (Cricsheet)
- Entity example files — CC-BY-4.0 (labeled examples only; no real player data)
