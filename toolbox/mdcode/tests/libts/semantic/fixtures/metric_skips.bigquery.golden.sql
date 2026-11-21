CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.skips`
NODE TABLES (
  `sqlgen-testing.demo.orders` AS orders
    KEY(o_orderkey)
    PROPERTIES(
      o_orderkey,
      customer_id,
      status,
      amount,
      MEASURE(SUM(amount)) AS revenue,
      MEASURE(SUM(amount) / COUNT(o_orderkey)) AS aov
    ),
  `sqlgen-testing.demo.customers` AS customers
    KEY(c_custkey)
    PROPERTIES(
      c_custkey
    )
)
EDGE TABLES (
  `sqlgen-testing.demo.orders` AS orders_to_customer
    KEY(o_orderkey)
    SOURCE KEY(o_orderkey) REFERENCES orders(o_orderkey)
    DESTINATION KEY(customer_id) REFERENCES customers(c_custkey)
    NO PROPERTIES
);

-- warnings --
-- metric 'clv' spans multiple tables (orders, customers); skipped (cannot be a single MEASURE)
-- metric 'spread' expression 'STDDEV(amount)' cannot be a measure: it uses STDDEV, which BigQuery does not allow in a measure (SUM, AVG, COUNT, MIN, MAX); skipped
-- metric 'status' collides with an existing property of entity 'orders'; skipped (rename the metric to avoid a duplicate graph property)
