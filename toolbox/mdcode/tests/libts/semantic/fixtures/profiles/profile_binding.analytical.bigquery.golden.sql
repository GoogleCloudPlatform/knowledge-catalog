CREATE OR REPLACE PROPERTY GRAPH `acme.sales.commerce`
NODE TABLES (
  `acme.sales.customers` AS Customer
    KEY(cust_id)
    PROPERTIES(
      cust_id AS id OPTIONS(description="Customer ID"),
      full_name AS name
    ),
  `acme.sales.orders` AS `Order`
    KEY(order_id)
    PROPERTIES(
      order_id AS id,
      fk_customer AS customerId,
      gross_amount AS amount,
      MEASURE(COUNT(id)) AS order_count,
      MEASURE(SUM(amount)) AS total_amount
    )
)
EDGE TABLES (
  `acme.sales.orders` AS placed_by
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES `Order`(order_id)
    DESTINATION KEY(fk_customer) REFERENCES Customer(cust_id)
);

-- availability --
unbound field: Customer.segment
dropped metric: segment_count (field Customer.segment is unbound)
-- warnings --
-- (none)
