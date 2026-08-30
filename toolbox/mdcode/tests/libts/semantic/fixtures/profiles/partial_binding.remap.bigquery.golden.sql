CREATE OR REPLACE PROPERTY GRAPH `acme-eu.sales.sales`
NODE TABLES (
  `acme-eu.sales.customers` AS Customer
    KEY(customer_id)
    PROPERTIES(
      customer_id AS id OPTIONS(description="Customer ID"),
      full_name AS name
    ),
  `acme-eu.sales.orders` AS Order
    KEY(order_id)
    PROPERTIES(
      order_id AS id,
      customer_id AS customerId,
      amount,
      MEASURE(COUNT(id)) AS order_count,
      MEASURE(SUM(amount)) AS total_amount
    )
)
EDGE TABLES (
  `acme-eu.sales.orders` AS placed_by
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES Order(order_id)
    DESTINATION KEY(customer_id) REFERENCES Customer(customer_id)
);

-- availability --
unbound field: Order.discount
dropped metric: total_discount (field Order.discount is unbound)
-- warnings --
-- (none)
