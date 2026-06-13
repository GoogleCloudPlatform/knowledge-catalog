# Postmortem: Q3 Apparel Class-A Stockouts

**Status:** Final **Owner:** Supply Chain Analytics **Date:** End of Q3 (most recent decision of record on this topic)

## Summary

During Q3, several Class-A apparel SKUs stocked out at forward DCs despite the planning system operating as designed. No system fault was found. The root cause was that our safety stock parameters were undersized for current demand variability.

## Timeline

- Weeks 4–6: three near-miss events flagged in Demand Planning syncs.
- Week 7: two Class-A SKUs hit zero on-hand at a forward DC for \~2 days.
- Week 8: investigation opened.

## Root cause

The reorder point fired correctly each time — on-hand fell to the reorder point and a PO was generated on schedule. The problem was upstream of the trigger: the **safety stock** cushion was too thin. Class-A safety stock had been set at **14 days of supply** against last year's variability. Demand variability for apparel has risen materially since then, so 14 days no longer covered the gap between reorder firing and replenishment landing. Because the reorder point is computed on top of safety stock, an undersized safety stock also meant the reorder point was firing later than it should have.

## Corrective action

Effective immediately, **Class-A safety stock is raised to 21 days of supply.** This is the new value planning should apply for Class-A items; it reflects current-year demand variability and supersedes the figure in the standing Inventory Policy Memo for Class A. Class B and C remain under review and are unchanged for now.

The reorder point was not adjusted directly; raising safety stock to 21 days will lift the Class-A reorder point automatically through the standard formula.

## Follow-ups

1. Analytics to fold the 21-day Class-A figure into the next Inventory Policy Memo revision.
2. Re-evaluate Class B/C safety stock against current variability next quarter.
