-- Tables the commerce model binds to under the `alloydb` profile.
--
-- The same three entities as schema.spanner.sql, laid out the way someone who
-- only ever used PostgreSQL would lay them out. The differences are deliberate
-- and are the point of this file: the table is `purchase_order`, not `Orders`;
-- the lines are `order_line`, not `LineItem`; an order's total column is
-- `order_total`, not `total`. Nothing in commerce.yaml changes to accommodate
-- any of that, because a table name and a column name are physical facts and
-- physical facts live in a binding profile.
--
-- PostgreSQL folds an unquoted identifier to lower case, so a schema written in
-- CamelCase would answer to names it was not written in. Everything here is
-- lower case, and the runtime double-quotes every identifier it generates, so
-- what the profile says a column is called is what reaches the database.
--
-- Money is numeric rather than double precision, for the same reason as on the
-- Spanner side: an order's total is an exact sum of exact amounts, and binary
-- floating point does not keep that promise.
--
-- Applied with `psql -f`; see the README for the command. As on the Spanner
-- side, the tables exist before the model is pushed -- though on AlloyDB there
-- is no graph to push, which is why the `alloydb` profile's deployment target
-- names a database and stops there.

CREATE TABLE IF NOT EXISTS customer (
  customer_id bigint PRIMARY KEY,
  name        text,
  email       text
);

CREATE TABLE IF NOT EXISTS purchase_order (
  order_id     bigint PRIMARY KEY,
  customer_id  bigint REFERENCES customer (customer_id),
  placed_on    date,
  order_total  numeric(12, 2),
  status       text
);

CREATE TABLE IF NOT EXISTS order_line (
  line_item_id text PRIMARY KEY,
  order_id     bigint REFERENCES purchase_order (order_id),
  type         text,
  amount       numeric(12, 2),
  memo         text
);
