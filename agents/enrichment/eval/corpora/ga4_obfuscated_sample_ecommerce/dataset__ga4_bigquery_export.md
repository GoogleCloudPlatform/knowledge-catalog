# GA4 BigQuery Export — Google Merchandise Store (dataset overview)

Source: `bigquery-public-data.ga4_obfuscated_sample_ecommerce`
Source: GA4 BigQuery Export schema — https://support.google.com/analytics/answer/7029846
Source: GA4 BigQuery cookbook (example queries by use case)

## What this dataset is

This dataset is a **Google Analytics 4 (GA4) BigQuery Export** of the public
**Google Merchandise Store** (an online store selling Google-branded
merchandise). It is the obfuscated sample GA4 export used in Google's GA4
BigQuery documentation. It contrasts with multi-table datasets (e.g. Bitcoin,
Stack Overflow): GA4 is a **single, wide, denormalized `events` table** where all
of an event's context (user, device, geo, traffic source, ecommerce, items) is
packed into the same row via nested/repeated RECORD columns.

## The event model

GA4 is **event-based**: there is **one row per event**, not per session or per
pageview. Every user interaction is an event with an `event_name` such as
`page_view`, `session_start`, `view_item`, `add_to_cart`, `begin_checkout`, and
`purchase`. Sessions and users are reconstructed at query time from event fields
(e.g. the `ga_session_id` event parameter), not stored as separate tables.

## Daily sharding

In the real export the events live in **date-sharded tables named
`events_YYYYMMDD`** (one table per day), queried together with a wildcard
(`events_*`) and a `_TABLE_SUFFIX` filter. This eval uses a single representative
`events` table that carries the same schema.

## Identity

- **`user_pseudo_id`** — the pseudonymous device/instance identifier; the primary
  key for counting users when no business id is set.
- **`user_id`** — the business-supplied user id (often null), used to stitch a
  signed-in user across devices.

---
*Source: GA4 BigQuery Export documentation (support.google.com/analytics) — factual.*
