# Bill of Materials — Engineering Specification

**Owner:** Product Engineering **Audience:** Design engineers, manufacturing planners

This specification defines how a **Bill of Materials (BOM)** is authored and maintained for products we manufacture or assemble.

## What the BOM is

The BOM is the authoritative, structured definition of what goes into a product. For a given finished-good **SKU**, the BOM lists every component and sub-assembly and the exact quantity of each required to build one unit. It is the bridge between engineering intent and what procurement actually buys: change the BOM and you change the shopping list.

## Structure

BOMs are **hierarchical (multi-level)**. A finished good is composed of sub-assemblies; each sub-assembly is itself a parent with its own BOM of lower components, and so on down to purchased raw components. This tree lets us reuse a sub-assembly across many products — its BOM is defined once and referenced wherever it is used.

Each line in a BOM carries, at minimum, the component identity and the per-parent quantity. A finished-good SKU has exactly one released BOM at a time; revisions are versioned so that production always builds against a known recipe.

## Relationship to SKUs

Every manufactured finished-good SKU maps to a BOM. The reverse is not one-to-one: a single component can appear in the BOMs of many different finished SKUs. When demand is planned at the finished-SKU level, the planning system "explodes" each SKU through its BOM to derive how many of each component must be procured — multiplying parent demand by the per-unit quantities at every level of the tree.

## Change control

BOM changes are engineering-controlled. Because a BOM edit directly alters component demand and procurement, no buyer or planner may alter component quantities outside the BOM. Engineering releases a new BOM revision; downstream systems pick it up automatically.
