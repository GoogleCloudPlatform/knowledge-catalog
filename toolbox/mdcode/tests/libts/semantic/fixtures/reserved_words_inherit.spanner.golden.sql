CREATE OR REPLACE PROPERTY GRAPH reserved_words_inherit
NODE TABLES (
  orders AS `Order`
    KEY(order_id)
    DEFAULT LABEL
    PROPERTIES(
      order_id AS id,
      amount AS total
    ),
  vip_orders AS Vip
    KEY(order_id)
    DEFAULT LABEL
    PROPERTIES(
      order_id AS id,
      vip_tier AS tier,
      amount AS total
    )
    LABEL `Order`
    PROPERTIES(
      order_id AS id,
      amount AS total
    )
);

-- warnings --
-- (none)
