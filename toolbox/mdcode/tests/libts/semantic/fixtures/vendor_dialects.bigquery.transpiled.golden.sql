CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.vendor_sales`
NODE TABLES (
  `samples.tpch.orders` AS orders
    KEY(o_orderkey)
    OPTIONS(description="One row per order")
    PROPERTIES(
      o_orderkey,
      o_custkey,
      o_orderstatus,
      o_totalprice,
      IF(o_orderstatus = 'F', 'fulfilled', 'open') AS order_status_label OPTIONS(description="Human-readable order status"),
      COALESCE(o_clerk, 'unknown') AS clerk_name,
      SAFE_CAST(o_totalprice AS FLOAT64) AS price_float,
      DATE_ADD(o_orderdate, INTERVAL 7 DAY) AS due_date,
      IF(o_orderstatus = 'F', o_totalprice, 0) AS fulfilled_revenue_input,
      CAST(COALESCE(o_totalprice, 0) AS NUMERIC) AS avg_price_known_input,
      MEASURE(SUM(o_totalprice)) AS total_revenue OPTIONS(description="Total order revenue (portable control expression)"),
      MEASURE(SUM(fulfilled_revenue_input)) AS fulfilled_revenue OPTIONS(description="Revenue from fulfilled orders"),
      MEASURE(AVG(avg_price_known_input)) AS avg_price_known OPTIONS(description="Average order price, treating NULL as zero")
    ),
  `samples.tpch.customer` AS customer
    KEY(c_custkey)
    PROPERTIES(
      c_custkey
    )
)
EDGE TABLES (
  `samples.tpch.orders` AS orders_to_customer
    KEY(o_orderkey)
    SOURCE KEY(o_orderkey) REFERENCES orders(o_orderkey)
    DESTINATION KEY(o_custkey) REFERENCES customer(c_custkey)
    NO PROPERTIES
);

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- field 'orders.order_status_label': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'orders.clerk_name': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'orders.comment_text': could not transpile 'DATABRICKS' -> 'BIGQUERY' (kcmd does not translate CAST to TEXT); left untranslated
-- field 'orders.price_float': transpiled 'DATABRICKS' -> 'BIGQUERY'
-- field 'orders.due_date': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'orders.ship_days': could not transpile 'SNOWFLAKE' -> 'BIGQUERY' (kcmd does not translate DATEDIFF); left untranslated
-- field 'customer.phone_is_numeric': could not transpile 'SNOWFLAKE' -> 'BIGQUERY' (kcmd does not translate REGEXP_LIKE); left untranslated
-- field 'customer.is_auto_segment': could not transpile 'DATABRICKS' -> 'BIGQUERY' (kcmd does not translate ILIKE); left untranslated
-- metric 'fulfilled_revenue': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- metric 'avg_price_known': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- entity 'orders': field 'comment_text' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'orders': field 'ship_days' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'customer': field 'phone_is_numeric' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'customer': field 'is_auto_segment' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
