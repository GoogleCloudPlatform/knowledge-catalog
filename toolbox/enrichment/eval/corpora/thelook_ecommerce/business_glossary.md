# theLook eCommerce — Business Glossary

**Owner:** Commerce Data & Analytics
**Audience:** Analysts, data scientists, and engineers querying the eCommerce warehouse

Shared definitions for the core business concepts in the theLook eCommerce
dataset. theLook is a multi-brand online apparel and accessories retailer. Use
these definitions so metrics and reports mean the same thing across teams.

## Order vs. Order Item

These are two different grains and must not be confused.

- An **Order** is a single purchase event placed by a customer. One order can
  contain many items; `num_of_item` records how many. An order carries an overall
  fulfillment `status` and the customer who placed it (`user_id`).
- An **Order Item** is a single unit of a single product within an order. It is
  the **revenue grain** — every line that a customer actually paid for is one
  order item. Revenue, margin, and units-sold are all computed at this grain, not
  at the order grain.

A customer who buys two shirts and one hat in one checkout creates **one order**
and **three order items**.

## Sale Price, Retail Price, and Cost

These three money fields are easy to mix up; they are distinct and live on
different tables.

- **Cost** — what theLook paid its supplier for the unit (wholesale / landed
  cost). Found as `products.cost` and `inventory_items.cost`. Never shown to the
  customer.
- **Retail Price** — the list price theLook advertises for a product
  (`products.retail_price`). This is the catalog price, *before* any discount.
- **Sale Price** — the price the customer **actually paid** for a unit, recorded
  on the transaction line as `order_items.sale_price`. This is the authoritative
  figure for revenue. Sale price may differ from retail price because of
  promotions or markdowns.

**Rule of thumb:** revenue uses `order_items.sale_price`; margin compares it to
`cost`; `retail_price` is the reference list price, not realized revenue.

## Gross Margin

**Gross Margin** is the profit on a unit before operating costs:
`sale_price - cost` per order item (or `retail_price - cost` at list price for
catalog analysis). **Gross Margin %** is `gross_margin / sale_price`.

## SKU and Product Taxonomy

- **SKU (Stock Keeping Unit)** — the identifier theLook uses to track a sellable
  product variant in inventory (`products.sku`). One SKU corresponds to one row
  in `products`.
- Products are organized in a three-level taxonomy:
  - **Department** — the broadest grouping (e.g. Men, Women).
  - **Category** — the product type within a department (e.g. Jeans, Outerwear).
  - **Brand** — the manufacturer or label.

## Distribution Center

A **Distribution Center** is a physical warehouse that stocks and ships
products. Every product is assigned to exactly one distribution center via
`products.distribution_center_id`. Distribution centers carry a name and a
geographic location (latitude/longitude) used for fulfillment and shipping-time
analysis.

## Inventory Item

An **Inventory Item** is one physical unit of a product held in stock. It is
created when stock is received (`created_at`) and is marked `sold_at` when it is
purchased. The difference between those two timestamps is how long the unit sat
in inventory before selling.

## Traffic Source

**Traffic Source** is the marketing channel that brought a customer to theLook,
stored on `users.traffic_source`. Typical values are Search, Organic, Email,
Display, and Facebook. It is the basis for customer-acquisition and
channel-attribution analysis.
