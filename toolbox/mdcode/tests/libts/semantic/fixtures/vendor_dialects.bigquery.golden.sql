CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.vendor_sales`
NODE TABLES (
  `samples.tpch.orders` AS orders
    KEY(o_orderkey)
    OPTIONS(description="One row per order")
    PROPERTIES(
      o_orderkey,
      o_custkey,
      IFF(o_orderstatus = 'F', 'fulfilled', 'open') AS order_status_label OPTIONS(description="Human-readable order status"),
      NVL(o_clerk, 'unknown') AS clerk_name,
      o_comment::text AS comment_text,
      o_totalprice::double AS price_float,
      DATEADD(day, 7, o_orderdate) AS due_date,
      DATEDIFF(day, o_orderdate, o_shipdate) AS ship_days,
      o_totalprice,
      IFF(o_orderstatus = 'F', o_totalprice, 0) AS fulfilled_revenue_input,
      NVL(o_totalprice, 0) AS avg_price_known_input,
      MEASURE(SUM(o_totalprice)) AS total_revenue OPTIONS(description="Total order revenue (portable control expression)"),
      MEASURE(SUM(fulfilled_revenue_input)) AS fulfilled_revenue OPTIONS(description="Revenue from fulfilled orders"),
      MEASURE(AVG(avg_price_known_input)) AS avg_price_known OPTIONS(description="Average order price, treating NULL as zero")
    ),
  `samples.tpch.customer` AS customer
    KEY(c_custkey)
    PROPERTIES(
      c_custkey,
      REGEXP_LIKE(c_phone, '[0-9]+') AS phone_is_numeric,
      c_mktsegment ILIKE 'AUTO%' AS is_auto_segment
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
-- field 'orders.order_status_label': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'SNOWFLAKE' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- field 'orders.clerk_name': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'SNOWFLAKE' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- field 'orders.comment_text': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'DATABRICKS' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- field 'orders.price_float': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'DATABRICKS' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- field 'orders.due_date': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'SNOWFLAKE' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- field 'orders.ship_days': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'SNOWFLAKE' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- field 'customer.phone_is_numeric': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'SNOWFLAKE' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- field 'customer.is_auto_segment': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'DATABRICKS' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- metric 'fulfilled_revenue': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'SNOWFLAKE' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- metric 'avg_price_known': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'SNOWFLAKE' expression as imported_expression (needs transpilation to 'BIGQUERY')
