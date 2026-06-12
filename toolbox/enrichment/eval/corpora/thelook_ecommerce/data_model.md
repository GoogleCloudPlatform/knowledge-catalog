# theLook eCommerce — Data Model and Relationships

**Owner:** Commerce Data & Analytics
**Audience:** Engineers and analysts joining across the eCommerce tables

The grain of each table and how the tables relate. Use this to write correct
joins and to understand lineage.

## Tables and their grain

- **`users`** — one row per customer. Grain: customer. Holds demographics
  (age, gender), location (city/state/country, lat/long), acquisition channel
  (`traffic_source`), and signup time (`created_at`).
- **`orders`** — one row per order (a checkout event). Grain: order. Links to the
  customer via `user_id`.
- **`order_items`** — one row per unit of a product in an order. Grain: order
  line / sold unit. This is the central fact table for revenue.
- **`products`** — one row per sellable product (SKU). Grain: product.
- **`inventory_items`** — one row per physical unit of stock. Grain: stock unit.
- **`distribution_centers`** — one row per fulfillment warehouse. Grain:
  warehouse.

## Relationships (foreign keys)

- `orders.user_id` → `users.id`
- `order_items.order_id` → `orders.order_id`
- `order_items.user_id` → `users.id`
- `order_items.product_id` → `products.id`
- `order_items.inventory_item_id` → `inventory_items.id`
- `products.distribution_center_id` → `distribution_centers.id`
- `inventory_items.product_id` → `products.id`

`order_items` is the hub: it ties together the customer, the order, the product,
and the specific inventory unit that was shipped. Most analytical queries start
from `order_items` and join outward.

## Denormalization note (important)

`inventory_items` **denormalizes** the product attributes. The `product_*`
columns on `inventory_items` (`product_category`, `product_name`,
`product_brand`, `product_retail_price`, `product_department`, `product_sku`,
`product_distribution_center_id`) are copies of the corresponding fields in
`products`, carried for convenience so inventory queries don't need a join. The
**authoritative source for product attributes is the `products` table** — if the
two ever disagree, trust `products`. Do not treat the `inventory_items.product_*`
columns as independent facts.

## Lineage summary

Customer (`users`) places an Order (`orders`), which is composed of Order Items
(`order_items`). Each order item references a Product (`products`) and the
physical Inventory Item (`inventory_items`) that fulfilled it. Products are
stocked and shipped from a Distribution Center (`distribution_centers`).
