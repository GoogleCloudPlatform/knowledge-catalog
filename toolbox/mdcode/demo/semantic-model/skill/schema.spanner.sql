-- Tables the commerce model binds to under the `spanner` profile.
--
-- Its siblings are schema.bigquery.sql and schema.alloydb.sql, which hold the
-- same three entities under different names and dialects. None of the three is
-- the real one: each is a physical layout that a binding profile maps the same
-- model onto.
--
-- A file because `gcloud spanner databases create --ddl-file` takes one, and
-- because `kcmd push` deploys a graph over tables that already exist rather
-- than creating them. The README applies it where it creates the store.
--
-- Money is NUMERIC rather than FLOAT64. An order's total is an exact sum of
-- exact amounts, and binary floating point does not keep that promise: 0.1 +
-- 0.2 is not 0.3 in FLOAT64, so a total summed from the lines would drift away
-- from the lines it was summed from.
--
-- WHY THE TOTAL IS A VIEW AND NOT A COLUMN. An order's total is the sum of its
-- lines, and that is the kind of rule a guard cannot keep: a guard is settled
-- before the write, and this one is about the state the write leaves behind.
-- Stored in a column it has to be maintained by whoever writes a line, so the
-- rule holds only as long as every writer remembers it. Derived in a view it
-- cannot be false. What that buys the action is the whole of this demo's
-- shape: crediting an order becomes ONE statement, inserting one line, because
-- there is no second row to keep in step with it. An action that is one
-- statement is atomic on every backend without anyone promising a transaction.
--
-- The view is called Orders because ORDER is a reserved word in GoogleSQL. The
-- model calls the entity Order and the binding profile maps it to this view,
-- which is what a logical name is for.

CREATE TABLE IF NOT EXISTS Customer (
  customer_id INT64 NOT NULL,
  name STRING(128),
  email STRING(256),
) PRIMARY KEY (customer_id);

CREATE TABLE IF NOT EXISTS OrderHeader (
  order_id INT64 NOT NULL,
  customer_id INT64,
  placed_on DATE,
  status STRING(16),
) PRIMARY KEY (order_id);

CREATE TABLE IF NOT EXISTS LineItem (
  line_item_id STRING(64) NOT NULL,
  order_id INT64,
  type STRING(16),
  amount NUMERIC,
  memo STRING(MAX),
) PRIMARY KEY (line_item_id);

-- Grouped by order_id, and aggregated rather than projected, so that Spanner
-- can see for itself that one row comes back per order. A property graph's
-- node table needs a key it can verify is unique, and a view is only allowed
-- to be one when the definition makes the uniqueness inferable -- the same
-- view written with a correlated subquery in the select list is rejected with
-- "we cannot verify the specified element key (`order_id`) is unique".
CREATE OR REPLACE VIEW Orders SQL SECURITY INVOKER AS
  SELECT o.order_id,
         ANY_VALUE(o.customer_id) AS customer_id,
         ANY_VALUE(o.placed_on) AS placed_on,
         ANY_VALUE(o.status) AS status,
         COALESCE(SUM(li.amount), 0) AS total
  FROM OrderHeader AS o
  LEFT JOIN LineItem AS li ON li.order_id = o.order_id
  GROUP BY o.order_id
