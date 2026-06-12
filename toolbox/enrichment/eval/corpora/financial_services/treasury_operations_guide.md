# Treasury Operations Guide

**Owner:** Group Treasury **Audience:** Treasury analysts and ALM team

This guide covers the day-to-day metrics Treasury manages: balance-sheet profitability, liquidity, and the mechanics of trade settlement.

## Net Interest Margin (NIM)

**Net Interest Margin (NIM)** is our core measure of balance-sheet profitability. It is the difference between the interest we earn on assets and the interest we pay on liabilities, expressed relative to our interest-earning assets:

**NIM \= (interest income − interest expense) / average earning assets**

NIM tells us how efficiently we are turning the balance sheet into net interest income. Treasury watches NIM against the rate environment: when funding costs rise faster than asset yields, NIM compresses, and vice versa.

## Liquidity Coverage Ratio (LCR)

Treasury owns the day-to-day management of the **Liquidity Coverage Ratio (LCR)** — high-quality liquid assets over 30-day net cash outflows. In normal operations we steer the LCR to the internal management target of **about 110%**, keeping headroom above the regulatory minimum defined under Basel III. Treasury forecasts the LCR daily and adjusts the HQLA portfolio to stay within appetite.

## Settlement

Treasury also oversees **settlement** — the finalization of trades by exchanging cash and securities. Our equities and most fixed-income trades settle on a **T+1** basis: settlement occurs one business day after the trade date. Each settlement day has a processing **cutoff** after which trades roll to the next cycle; per the Trade Operations Runbook the standing cutoff is **16:00 ET**. Trades instructed before the cutoff settle in that day's batch; later instructions settle the following business day.

## Daily routine

1. Refresh NIM and LCR forecasts from overnight balances.
2. Confirm the settlement pipeline is clear ahead of the cutoff.
3. Escalate any projected LCR move toward appetite limits.
