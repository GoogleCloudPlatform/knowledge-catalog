CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.sales`
NODE TABLES (
  `demo.sales.orders` AS orders
    KEY(o_orderkey)
    PROPERTIES(
      o_orderkey,
      o_totalprice,
      MEASURE(SUM(o_totalprice)) AS total_revenue
    )
);

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
