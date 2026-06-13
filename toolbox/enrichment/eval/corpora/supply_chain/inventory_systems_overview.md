# Inventory Systems Overview

**Audience:** New analysts and engineers integrating with our planning stack **Owner:** Supply Chain Analytics

This overview explains, in plain language, how the core inventory concepts relate to one another in our systems. It deliberately avoids field-level detail; it is about meaning, not schemas.

## Products and their identifiers

Everything in inventory hangs off the **SKU (Stock Keeping Unit)**. A SKU represents one sellable variant of a product — a specific size, color, and pack configuration. When merchandising launches a "product," engineering and planning see it as a set of SKUs, one per variant. The SKU is the level at which we forecast, hold stock, and replenish.

It is worth repeating a common point of confusion: the SKU is *internal*. The barcode a cashier scans is a **UPC/GTIN**, an external standard. We store the UPC/GTIN as an attribute so we can map scans back to a SKU, but the two are different identifiers with different owners — the UPC/GTIN comes from a global registry, the SKU is assigned by us. Treating them as the same thing causes double-counting, so keep them distinct.

## Finished goods and their recipes

For anything we manufacture or assemble, each finished-good SKU is associated with a **Bill of Materials (BOM)**. The BOM is the recipe: the list of components and sub-assemblies, and how many of each, required to build one unit of that SKU. BOMs can be multi-level — a sub-assembly named in one BOM may itself have its own BOM — which is how complex products are represented as a tree of simpler parts. The BOM is what links a finished SKU to the component materials procurement must buy.

## How it fits together

In short: demand is forecast per SKU; finished SKUs explode through their BOMs into component demand; that component demand drives procurement. The SKU is the hub that the rest of the system revolves around.
