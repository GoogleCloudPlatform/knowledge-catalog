CREATE OR REPLACE PROPERTY GRAPH sales
NODE TABLES (
  orders AS orders
    KEY(o_orderkey)
    PROPERTIES(
      o_orderkey,
      o_custkey,
      o_orderdate,
      o_totalprice
    ),
  customer AS customer
    KEY(c_custkey)
    PROPERTIES(
      c_custkey,
      c_name
    )
)
EDGE TABLES (
  orders AS orders_to_customer
    KEY(o_orderkey)
    SOURCE KEY(o_orderkey) REFERENCES orders(o_orderkey)
    DESTINATION KEY(o_custkey) REFERENCES customer(c_custkey)
);

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- metric 'total_revenue' is not emitted: Spanner Graph has no MEASURE, so model-level metrics have no home in it
-- metric 'order_count' is not emitted: Spanner Graph has no MEASURE, so model-level metrics have no home in it
