CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.lowering`
NODE TABLES (
  `sqlgen-testing.demo.orders` AS orders
    KEY(o_orderkey)
    PROPERTIES(
      o_orderkey,
      status,
      amount,
      IF(status = 'F', amount, 0) AS fulfilled_input,
      region AS region_input,
      IF(CAST(amount AS STRING) = 'orders.note', 0, amount) AS flagged_input,
      MEASURE(SUM(amount)) AS total_amount,
      MEASURE(SUM(fulfilled_input)) AS fulfilled,
      MEASURE(AVG(fulfilled_input)) AS avg_fulfilled,
      MEASURE(COUNT(DISTINCT status)) AS n_status,
      MEASURE(COUNT(region_input)) AS region,
      MEASURE(SUM(flagged_input)) AS flagged
    )
);

-- warnings --
-- (none)
