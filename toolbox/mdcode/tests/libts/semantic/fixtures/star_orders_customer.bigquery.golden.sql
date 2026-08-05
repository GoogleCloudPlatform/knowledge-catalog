CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.sales`
NODE TABLES (
  `samples.tpch.orders` AS orders
    KEY(o_orderkey)
    OPTIONS(description="One row per order")
    PROPERTIES(
      o_orderkey OPTIONS(description="Order identifier"),
      o_custkey,
      o_orderdate OPTIONS(description="Order Date\n\nTime dimension.\n\nSynonyms: order date, date"),
      o_totalprice,
      MEASURE(SUM(o_totalprice)) AS total_revenue OPTIONS(description="Total order revenue\n\nSynonyms: revenue, sales")
    ),
  `samples.tpch.customer` AS customer
    KEY(c_custkey)
    PROPERTIES(
      c_custkey,
      c_name OPTIONS(description="Customer name")
    )
)
EDGE TABLES (
  `samples.tpch.orders` AS orders_to_customer
    KEY(o_orderkey)
    SOURCE KEY(o_orderkey) REFERENCES orders(o_orderkey)
    DESTINATION KEY(o_custkey) REFERENCES customer(c_custkey)
)
OPTIONS(description="Sales orders with customer attributes\n\nUse this model for order analysis.");

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- metric 'order_count': expression references no known entity; it may not be placeable downstream
-- metric 'order_count' references no known entity; skipped (cannot be a single MEASURE)
