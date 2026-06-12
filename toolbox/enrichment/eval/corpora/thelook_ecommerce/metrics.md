# theLook eCommerce — Metric Definitions

**Owner:** Commerce Data & Analytics
**Purpose:** Canonical formulas for the core commerce metrics, expressed against
the warehouse columns. Use these so every team computes the same number.

All revenue and unit metrics are computed at the **order-item grain**
(`order_items`), which is the sold-unit grain. See the Business Glossary for the
Order vs. Order Item distinction and the price definitions.

## Revenue

**Gross Revenue** = `SUM(order_items.sale_price)` over items whose status is not
Cancelled.

**Net Revenue** = `SUM(order_items.sale_price)` over items that are neither
Cancelled nor Returned. Net revenue is gross revenue with returns removed.

> Always exclude Cancelled items from any revenue figure; exclude Returned items
> additionally for *net* revenue.

## Average Order Value (AOV)

**AOV** = Gross Revenue / number of distinct orders
= `SUM(order_items.sale_price) / COUNT(DISTINCT order_items.order_id)`.
AOV is an order-grain metric derived from item-grain revenue.

## Units Sold

**Units Sold** = `COUNT(order_items.id)` for non-cancelled items. Each order item
is one unit.

## Return Rate

**Return Rate** = returned units / sold units
= `COUNT(order_items WHERE returned_at IS NOT NULL) / COUNT(order_items WHERE status <> 'Cancelled')`.

## Gross Margin and Margin %

**Gross Margin** = `SUM(order_items.sale_price - products.cost)` (join
`order_items.product_id` → `products.id`), over non-returned, non-cancelled items.

**Gross Margin %** = Gross Margin / Net Revenue.

## Inventory Sell-Through and Days-in-Inventory

**Sell-Through Rate** = sold inventory units / total inventory units
= `COUNT(inventory_items WHERE sold_at IS NOT NULL) / COUNT(inventory_items)`.

**Average Days in Inventory** = mean of `(sold_at - created_at)` over sold
inventory items — how long a unit sits in stock before it sells.

## Customer Acquisition by Channel

Group `users` by `traffic_source` to attribute customers (and, by joining through
orders, revenue) to acquisition channels.
