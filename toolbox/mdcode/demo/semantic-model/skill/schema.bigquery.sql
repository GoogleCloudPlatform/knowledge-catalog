-- Tables the commerce model binds to under the `bigquery` profile.
--
-- The same three entities as schema.spanner.sql, in a dataset. BigQuery is a
-- warehouse rather than a transactional database, and a write here costs what
-- a warehouse write costs -- but it executes DML, which is the only thing an
-- action's `sql` executor asks of a store. What that gets you is the third
-- backend the same model runs on, and the second one `kcmd push` can check the
-- action's statements against before anything is published.
--
-- The names are snake_case because that is what a warehouse schema usually
-- looks like. As everywhere else in this demo, the model does not know: it
-- calls the entities Customer, Order and LineItem under all three profiles.
--
-- Money is NUMERIC, for the same reason as on the other two.
--
-- `orders` is a view over `order_header`, for the reason spelled out at length
-- in schema.spanner.sql.
--
-- Apply it with:
--
--   bq query --use_legacy_sql=false --project_id=my-project < schema.bigquery.sql
--
-- after creating the dataset:
--
--   bq mk --dataset --location=us-central1 my-project:semantic_skill_demo

CREATE TABLE IF NOT EXISTS `my-project.semantic_skill_demo.customer` (
  customer_id INT64 NOT NULL,
  name        STRING,
  email       STRING
);

CREATE TABLE IF NOT EXISTS `my-project.semantic_skill_demo.order_header` (
  order_id    INT64 NOT NULL,
  customer_id INT64,
  placed_on   DATE,
  status      STRING
);

CREATE TABLE IF NOT EXISTS `my-project.semantic_skill_demo.line_item` (
  line_item_id STRING NOT NULL,
  order_id     INT64,
  type         STRING,
  amount       NUMERIC,
  memo         STRING
);

CREATE OR REPLACE VIEW `my-project.semantic_skill_demo.orders` AS
  SELECT h.order_id,
         h.customer_id,
         h.placed_on,
         h.status,
         COALESCE(SUM(l.amount), 0) AS total
  FROM `my-project.semantic_skill_demo.order_header` AS h
  LEFT JOIN `my-project.semantic_skill_demo.line_item` AS l
    ON l.order_id = h.order_id
  GROUP BY h.order_id, h.customer_id, h.placed_on, h.status;
