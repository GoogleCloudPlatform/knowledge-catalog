CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.sales_graph`
NODE TABLES (
  `sqlgen-testing.demo.customers` AS customers
    KEY(customer_id)
    PROPERTIES(
      customer_id,
      region
    ),
  `sqlgen-testing.demo.orders` AS orders
    KEY(order_id)
    PROPERTIES(
      order_id,
      customer_id,
      MEASURE(COUNT(order_id)) AS order_count
    ),
  `sqlgen-testing.demo.order_items` AS order_items
    KEY(order_item_id)
    PROPERTIES(
      order_item_id,
      order_id,
      amount,
      MEASURE(SUM(amount)) AS total_revenue
    )
)
EDGE TABLES (
  `sqlgen-testing.demo.orders` AS orders_customers
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES orders(order_id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id),
  `sqlgen-testing.demo.order_items` AS orderitems_orders
    KEY(order_item_id)
    SOURCE KEY(order_item_id) REFERENCES order_items(order_item_id)
    DESTINATION KEY(order_id) REFERENCES orders(order_id)
);

-- warnings --
-- (none)
