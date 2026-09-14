CREATE OR REPLACE PROPERTY GRAPH `acme-ops.ops.commerce`
NODE TABLES (
  `acme-ops.ops.dim_customer` AS Customer
    KEY(cust_key)
    PROPERTIES(
      cust_key AS id OPTIONS(description="Customer ID"),
      cust_name AS name,
      cust_segment AS segment,
      MEASURE(COUNT(segment)) AS segment_count
    ),
  `acme-ops.ops.fct_order` AS `Order`
    KEY(order_key)
    PROPERTIES(
      order_key AS id,
      cust_key AS customerId,
      MEASURE(COUNT(id)) AS order_count
    )
)
EDGE TABLES (
  `acme-ops.ops.fct_order` AS placed_by
    KEY(order_key)
    SOURCE KEY(order_key) REFERENCES `Order`(order_key)
    DESTINATION KEY(cust_key) REFERENCES Customer(cust_key)
);

-- availability --
unbound field: Order.amount
dropped metric: total_amount (field Order.amount is unbound)
-- warnings --
-- (none)
