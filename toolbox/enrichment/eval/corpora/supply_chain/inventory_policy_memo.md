# Inventory Policy Memo

**Classification:** Decision of record **Owner:** Supply Chain Analytics **Supersedes:** prior year's policy memo

This memo defines the inventory parameters our planning system uses. Values here are authoritative until a subsequent memo or postmortem revises them.

## Reorder point

The **reorder point (ROP)** is the on-hand level that triggers a replenishment order for a SKU. We compute it as:

**ROP \= (average daily demand × lead time in days) \+ safety stock**

The first term covers expected consumption during the time it takes to replenish; the second term is the cushion against variability. Because the ROP is built directly on lead time and safety stock, any change to either flows through to the ROP automatically. We do not set the ROP by hand.

## Safety stock

**Safety stock** is the buffer held above expected demand to protect service against demand spikes and lead-time variability. Our current policy sizes safety stock in **days of supply**, differentiated by velocity class:

- **Class A (fast movers): 14 days of supply.**
- Class B: 10 days of supply.
- Class C: 7 days of supply.

These figures were set against last year's observed demand variability. They are the values planning should use unless a later decision of record changes them.

## Review cadence

Safety stock days are reviewed at minimum annually, or sooner if a stockout postmortem recommends a change. Lead time is monitored continuously by procurement; a sustained lead-time shift is grounds for an off-cycle review.
