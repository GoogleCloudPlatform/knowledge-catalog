CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.vendor_sales`
NODE TABLES (
  `samples.tpch.orders` AS orders
    KEY(o_orderkey)
    OPTIONS(description="One row per order")
    PROPERTIES(
      o_orderkey,
      o_custkey,
      IF(o_orderstatus = 'F', 'fulfilled', 'open') AS order_status_label OPTIONS(description="Human-readable order status"),
      COALESCE(o_clerk, 'unknown') AS clerk_name,
      CAST(o_comment AS STRING) AS comment_text,
      CAST(o_totalprice AS FLOAT64) AS price_float,
      DATE_ADD(o_orderdate, INTERVAL 7 DAY) AS due_date,
      DATE_DIFF(o_shipdate, o_orderdate, DAY) AS ship_days,
      o_totalprice,
      IF(o_orderstatus = 'F', o_totalprice, 0) AS fulfilled_revenue_input,
      COALESCE(o_totalprice, 0) AS avg_price_known_input,
      MEASURE(SUM(o_totalprice)) AS total_revenue OPTIONS(description="Total order revenue (portable control expression)"),
      MEASURE(SUM(fulfilled_revenue_input)) AS fulfilled_revenue OPTIONS(description="Revenue from fulfilled orders"),
      MEASURE(AVG(avg_price_known_input)) AS avg_price_known OPTIONS(description="Average order price, treating NULL as zero")
    ),
  `samples.tpch.customer` AS customer
    KEY(c_custkey)
    PROPERTIES(
      c_custkey,
      REGEXP_CONTAINS(c_phone, '[0-9]+') AS phone_is_numeric,
      LOWER(c_mktsegment) LIKE LOWER('AUTO%') AS is_auto_segment
    )
)
EDGE TABLES (
  `samples.tpch.orders` AS orders_to_customer
    KEY(o_orderkey)
    SOURCE KEY(o_orderkey) REFERENCES orders(o_orderkey)
    DESTINATION KEY(o_custkey) REFERENCES customer(c_custkey)
)
OPTIONS(description="Orders and customers with vendor-dialect expressions");

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- field 'orders.order_status_label': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'orders.clerk_name': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'orders.comment_text': transpiled 'DATABRICKS' -> 'BIGQUERY'
-- field 'orders.price_float': transpiled 'DATABRICKS' -> 'BIGQUERY'
-- field 'orders.due_date': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'orders.ship_days': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'customer.phone_is_numeric': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- field 'customer.is_auto_segment': transpiled 'DATABRICKS' -> 'BIGQUERY'
-- metric 'fulfilled_revenue': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
-- metric 'avg_price_known': transpiled 'SNOWFLAKE' -> 'BIGQUERY'
