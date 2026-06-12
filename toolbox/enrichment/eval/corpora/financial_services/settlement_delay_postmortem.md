# Postmortem: Settlement Cutoff Migration Delay

**Status:** Final **Owner:** Trade Operations / Settlements **Date:** Most recent record on settlement timing — supersedes prior cutoff guidance where they conflict.

## Summary

Following migration to the new settlement platform, a batch of trades missed their intended settlement day. Investigation found the cause was an outdated cutoff time in our operating procedure: the new platform enforces an earlier cutoff than the one analysts were working to.

## Background

We settle on **T+1** (one business day after trade date). Same-day inclusion in a settlement run depends on the daily **cutoff time**. The legacy runbook documented a **16:00 ET** cutoff, and analysts continued to work to that time after the migration.

## What happened

The migrated platform was configured to a **15:30 ET** cutoff to align with the upstream market infrastructure's new schedule. On the affected day, several trades matched between 15:30 and 16:00 ET. Analysts believed these were inside the window; the platform rolled them to the next business day, creating an unexpected extra day of settlement exposure and a set of client queries.

## Root cause

Stale procedure. The **cutoff moved to 15:30 ET** with the migration, but the runbook and analyst habits still reflected the old 16:00 ET time.

## Corrective action

- **Effective immediately, the settlement cutoff is 15:30 ET.** All settlement instructions must be matched and released by 15:30 ET to make the same-day run. This is the current cutoff and replaces the 16:00 ET figure in the Trade Operations Runbook.
- Update the Trade Operations Runbook to 15:30 ET.
- Add a platform alert at 15:15 ET warning of approaching cutoff.

## Follow-ups

1. Settlements lead to confirm the runbook is updated this week.
2. Communicate the 15:30 ET cutoff to all settlements analysts.
