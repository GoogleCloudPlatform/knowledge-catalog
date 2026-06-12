# Logistics Network Overview

**Owner:** Network Strategy **Audience:** Planning, transportation, and operations leadership

This document describes the shape of our physical distribution network and the role each tier plays.

## Network tiers

Our network moves goods from suppliers to demand through a tiered set of **distribution centers (DCs)**. A DC is a facility that stores inventory and fulfills downstream demand. We operate two tiers:

- **Regional DCs** hold broad assortment and replenish the next tier.
- **Forward DCs** (also called fulfillment nodes) sit closer to demand and ship directly to stores or customers.

Each DC, regardless of tier, maintains its own on-hand inventory per SKU and makes its own replenishment decisions. The network is therefore a graph of inventory-holding nodes, not a single pool of stock.

## Lead time across the network

When we talk about **lead time** at the network level, we mean the end-to-end time to get a SKU from its source to the node that needs it. There are two flavors:

- **Inbound lead time** — supplier PO to receipt at a regional DC. This is the lead time procurement plans against.
- **Inter-node lead time** — the transit time to move stock from a regional DC to a forward DC.

Both contribute to how much buffer a forward node must carry: the longer and more variable the combined lead time to a node, the more safety stock that node needs to maintain service. Network design is largely the exercise of trading off the number of DCs against the lead time (and therefore inventory) required to serve demand.

## Order routing

When demand arrives, the order router selects a DC that holds the needed SKU, preferring the node with the shortest fulfillment lead time to the destination. If the nearest node is out of stock, the router falls back to another node that holds the SKU.
