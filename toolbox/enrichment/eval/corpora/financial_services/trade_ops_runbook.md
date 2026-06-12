# Trade Operations Runbook

**Owner:** Trade Operations / Settlements **Audience:** Settlements analysts

This runbook is the operational reference for clearing and settling trades. It is the standing source for our settlement timing.

## What settlement is

**Settlement** is the process that finalizes a trade: the buyer's cash and the seller's securities actually change hands, discharging both parties' obligations. A trade is only economically complete once it has settled — until then it is a pending obligation carrying counterparty risk.

## Settlement cycle

Our equities and most fixed-income instruments settle on a **T+1** basis: settlement takes place **one business day after the trade date**. So a trade executed Monday settles Tuesday, assuming both are business days. Holidays and weekends extend the calendar accordingly.

## Daily cutoff

Each settlement day has a **cutoff time** that determines which batch a trade makes. **The standing cutoff is 16:00 ET.** Settlement instructions received and matched before 16:00 ET are processed in that day's settlement run; instructions arriving after the cutoff roll into the next business day's cycle. Operations must ensure all matched trades are instructed ahead of the cutoff to avoid an unintended extra day of settlement risk.

## Daily checklist

1. Confirm trades captured overnight are matched with counterparties.
2. Resolve any unmatched/affirmed exceptions well before the cutoff.
3. Release the settlement batch ahead of 16:00 ET.
4. Reconcile settled positions end of day; investigate any fails.

## Fails

A settlement fail (one side cannot deliver cash or securities) is logged, counterparty notified, and the trade re-attempted the next cycle. Persistent fails are escalated to the Settlements lead.
