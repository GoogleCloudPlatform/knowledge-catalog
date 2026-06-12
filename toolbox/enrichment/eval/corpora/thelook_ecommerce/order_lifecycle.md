# theLook eCommerce — Order Lifecycle and Status

**Owner:** Fulfillment Operations
**Audience:** Analysts working with orders, fulfillment, and returns

How an order moves from placement to completion (or return), and what each
status and timestamp means. Applies to both the `orders` table and the
`order_items` table.

## Order status

`orders.status` describes the overall state of the order. The lifecycle is:

1. **Processing** — the order has been placed and is being prepared; payment
   captured, not yet shipped.
2. **Shipped** — the order has left a distribution center.
3. **Complete** — the order was delivered and the return window has effectively
   closed.
4. **Returned** — one or more items came back; the order is in a returned state.
5. **Cancelled** — the order was cancelled before fulfillment and generated no
   revenue.

## Order Item status

`order_items.status` tracks the **same lifecycle at the line-item grain**. Because
an order can be partially fulfilled or partially returned, item status can differ
from the parent order's status — e.g. an order may be **Complete** while one of
its order items is **Returned**. Always compute fulfillment and return metrics
from `order_items.status`, not from `orders.status`, when item-level accuracy
matters.

## The timestamp funnel

Both `orders` and `order_items` carry a sequence of event timestamps that record
when the item moved through each stage:

- **`created_at`** — when the order/line was placed.
- **`shipped_at`** — when it shipped from the distribution center.
- **`delivered_at`** — when it reached the customer.
- **`returned_at`** — when it was returned, if applicable.

These enable funnel and cycle-time analysis: processing time
(`shipped_at - created_at`), transit time (`delivered_at - shipped_at`), and
return latency (`returned_at - delivered_at`). A NULL timestamp means that stage
has not happened.

## Returns

An order item is a **return** when `returned_at` is set (or its `status` is
Returned). Returns reverse the revenue and margin of that line and should be
excluded from net revenue. **Return Rate** is the share of sold units that were
later returned.

## Revenue-bearing vs. non-revenue states

Only **Complete**, **Shipped**, and **Processing** items represent realized or
in-flight revenue. **Cancelled** items never generated revenue and must be
excluded from all revenue metrics. **Returned** items generated revenue that was
subsequently reversed; exclude them from *net* revenue but keep them for
gross-vs-net and return analysis.
