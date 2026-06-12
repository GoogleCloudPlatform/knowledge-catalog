# Warehouse Operations Runbook

**Scope:** Day-to-day operations inside a distribution center (DC) **Owner:** DC Operations

## What a distribution center is

A **distribution center (DC)** is a facility that receives inventory in bulk, stores it, and fulfills downstream orders to stores or customers. Each DC is a node in our logistics network sitting between suppliers upstream and demand downstream. Critically, every DC holds and counts its own inventory independently: the same SKU can have very different on-hand quantities across DCs, and replenishment decisions are made per DC. People sometimes call these facilities "fulfillment centers" or "fulfillment nodes"; in our network the terms are used interchangeably.

## Inbound

1. Receive against the purchase order. Verify carton counts.
2. Inspect and post good quantity as available. Damaged units are quarantined.
3. Putaway: assign each **SKU** to a storage location. Because we track inventory at the SKU level, every putaway must be scanned to the exact SKU — not the product family — or downstream picks will fail.

## Storage and counts

Cycle counts run continuously by zone. Any count discrepancy is reconciled at the SKU \+ location level. The DC's on-hand position per SKU is what feeds the planning system's reorder calculations, so count accuracy directly affects when replenishment fires.

## Outbound

Picks are generated from downstream orders, batched by zone, packed, and manifested to the carrier. A DC only ships SKUs it physically holds; if a SKU is out of stock at one DC, the order router may source it from another DC in the network.

## Escalations

- Receiving mismatch vs PO → notify Procurement.
- Persistent stockouts of a fast-moving SKU → notify Demand Planning to review safety stock and reorder point.
