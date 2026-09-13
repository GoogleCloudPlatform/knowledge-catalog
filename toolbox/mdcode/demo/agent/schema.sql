-- Tables the commerce model binds to.
--
-- A file because `gcloud spanner databases create --ddl-file` takes one, and
-- because `kcmd push` deploys a graph over tables that already exist rather
-- than creating them. See the README for the command that applies it.
--
-- Money is NUMERIC rather than FLOAT64. An order's total is an exact sum of
-- exact amounts, and binary floating point does not keep that promise: 0.1 +
-- 0.2 is not 0.3 in FLOAT64, so a total recomputed from the lines would drift
-- away from the lines it was computed from.
--
-- The order table is called Orders because ORDER is a reserved word in
-- GoogleSQL. The model calls the entity Order and the binding profile maps it
-- to this table, which is what a logical name is for.

CREATE TABLE IF NOT EXISTS Customer (
  customer_id INT64 NOT NULL,
  name STRING(128),
  email STRING(256),
) PRIMARY KEY (customer_id);

CREATE TABLE IF NOT EXISTS Orders (
  order_id INT64 NOT NULL,
  customer_id INT64,
  placed_on DATE,
  total NUMERIC,
  status STRING(16),
) PRIMARY KEY (order_id);

CREATE TABLE IF NOT EXISTS LineItem (
  line_item_id STRING(64) NOT NULL,
  order_id INT64,
  type STRING(16),
  amount NUMERIC,
  memo STRING(MAX),
) PRIMARY KEY (line_item_id)
