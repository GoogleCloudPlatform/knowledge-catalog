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
      MEASURE(SUM(o_totalprice)) AS total_revenue OPTIONS(description="Total order revenue (portable control expression)")
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
);

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
-- metric 'fulfilled_revenue' has no 'BIGQUERY' or 'ANSI_SQL' expression; skipped (nothing to emit as a MEASURE)
-- metric 'avg_price_known' has no 'BIGQUERY' or 'ANSI_SQL' expression; skipped (nothing to emit as a MEASURE)
-- entity 'orders': field 'order_status_label' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'orders': field 'clerk_name' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'orders': field 'comment_text' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'orders': field 'price_float' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'orders': field 'due_date' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'orders': field 'ship_days' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'customer': field 'phone_is_numeric' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
-- entity 'customer': field 'is_auto_segment' has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the node table
