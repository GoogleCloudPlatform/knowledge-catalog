CREATE OR REPLACE PROPERTY GRAPH sales_graph
NODE TABLES (
  customers AS customers
    KEY(customer_id)
    PROPERTIES(
      customer_id,
      region
    ),
  orders AS orders
    KEY(order_id)
    PROPERTIES(
      order_id,
      customer_id
    ),
  order_items AS order_items
    KEY(order_item_id)
    PROPERTIES(
      order_item_id,
      order_id,
      amount
    )
)
EDGE TABLES (
  orders AS orders_customers
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES orders(order_id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id),
  order_items AS orderitems_orders
    KEY(order_item_id)
    SOURCE KEY(order_item_id) REFERENCES order_items(order_item_id)
    DESTINATION KEY(order_id) REFERENCES orders(order_id)
);

-- warnings --
-- metric 'total_revenue' is not emitted: Spanner Graph has no MEASURE, so model-level metrics have no home in it
-- metric 'order_count' is not emitted: Spanner Graph has no MEASURE, so model-level metrics have no home in it
