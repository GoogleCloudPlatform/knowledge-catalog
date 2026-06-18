# `events` — the GA4 events table (schema & nested records)

Source: GA4 BigQuery Export schema — https://support.google.com/analytics/answer/7029846
Source: `bigquery-public-data.ga4_obfuscated_sample_ecommerce` column structure

## Grain

**One row per event.** Each row records a single user interaction on the Google
Merchandise Store, identified by `event_name` and timestamped by
`event_timestamp` (microseconds since epoch); `event_date` is the `YYYYMMDD`
event date.

## Event parameters (repeated key-value)

- **`event_params`** is a `REPEATED RECORD` of `(key, value)` pairs — the
  event-scoped parameters. `value` is itself a record with typed sub-fields
  (`string_value`, `int_value`, `float_value`, `double_value`). Common keys
  include `page_location`, `page_title`, `ga_session_id`, `ga_session_number`,
  and (for ecommerce events) `currency` and `value`. You read a parameter by
  UNNESTing `event_params` and filtering on `key`.
- **`user_properties`** is the analogous `REPEATED RECORD` of user-scoped
  attributes.

## Nested context records (one per event)

Each event row carries single (non-repeated) RECORD columns describing its
context:
- **`device`** — `category`, `operating_system`, `mobile_brand_name`, `web_info`…
- **`geo`** — `continent`, `country`, `region`, `city`, `metro`.
- **`traffic_source`** — `source`, `medium`, `name` (the acquisition attribution
  for the user's first visit).
- **`app_info`**, **`privacy_info`**, **`user_ltv`** (lifetime value:
  `revenue`, `currency`).

## Ecommerce and items

- **`ecommerce`** — a RECORD with order-level metrics:
  `purchase_revenue_in_usd`, `total_item_quantity`, `refund_value_in_usd`,
  `shipping_value_in_usd`, `tax_value_in_usd`.
- **`items`** — a `REPEATED RECORD`, one element per product in the event (e.g.
  the products in a `purchase` or `add_to_cart`). Each item has `item_id`,
  `item_name`, `item_brand`, `item_category`, `price`, `quantity`.

## How sessions & ecommerce are derived

There are no session or order tables: a **session** is the set of events sharing
the same `user_pseudo_id` + `ga_session_id` (from `event_params`); a **purchase**
is an event with `event_name = 'purchase'`, whose revenue is in `ecommerce` and
whose line items are in `items`. This denormalized, nested design is what lets one
table answer user-, session-, and order-level questions.

---
*Source: GA4 BigQuery Export schema reference — factual.*
