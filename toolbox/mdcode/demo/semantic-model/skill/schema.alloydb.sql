-- Tables the commerce model binds to under the `alloydb` profile.
--
-- The same three entities as schema.spanner.sql, laid out the way someone who
-- only ever used PostgreSQL would lay them out. The differences are deliberate
-- and are the point of this file: the lines are `order_line`, not `LineItem`;
-- an order's total column is `order_total`, not `total`; and what the model
-- calls Order is `purchase_order` here. Nothing in commerce.yaml changes to
-- accommodate any of that, because a table name and a column name are physical
-- facts and physical facts live in a binding profile.
--
-- PostgreSQL folds an unquoted identifier to lower case, so a schema written in
-- CamelCase would answer to names it was not written in. Everything here is
-- lower case, and the profile names each column in the case the database uses.
--
-- Money is numeric rather than double precision, for the same reason as on the
-- Spanner side: an order's total is an exact sum of exact amounts, and binary
-- floating point does not keep that promise.
--
-- `purchase_order` is a view over `order_header`, for the reason spelled out at
-- length in schema.spanner.sql: a total derived from the lines cannot disagree
-- with them, which is what lets IssueCredit be a single INSERT here as well.
--
-- Apply it with:
--
--   psql "host=127.0.0.1 port=5432 user=postgres dbname=semantic_skill_demo" \
--     -f schema.alloydb.sql
--
-- through the AlloyDB Auth Proxy. As on the Spanner side the tables exist
-- before the model is pushed -- though on AlloyDB there is no graph to push,
-- which is why the `alloydb` profile's deployment target names a database and
-- stops there.

CREATE TABLE IF NOT EXISTS customer (
  customer_id bigint PRIMARY KEY,
  name        text,
  email       text
);

CREATE TABLE IF NOT EXISTS order_header (
  order_id     bigint PRIMARY KEY,
  customer_id  bigint REFERENCES customer (customer_id),
  placed_on    date,
  status       text
);

CREATE TABLE IF NOT EXISTS order_line (
  line_item_id text PRIMARY KEY,
  order_id     bigint REFERENCES order_header (order_id),
  type         text,
  amount       numeric(12, 2),
  memo         text
);

CREATE OR REPLACE VIEW purchase_order AS
  SELECT h.order_id,
         h.customer_id,
         h.placed_on,
         h.status,
         COALESCE(SUM(l.amount), 0) AS order_total
  FROM order_header AS h
  LEFT JOIN order_line AS l ON l.order_id = h.order_id
  GROUP BY h.order_id, h.customer_id, h.placed_on, h.status;
