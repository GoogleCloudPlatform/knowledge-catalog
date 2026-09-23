CREATE OR REPLACE PROPERTY GRAPH reserved_words
NODE TABLES (
  orders AS `Order`
    KEY(order_id)
    PROPERTIES(
      order_id AS id,
      group_fk AS groupId,
      `order` AS rank
    ),
  `groups` AS `Group`
    KEY(group_id)
    PROPERTIES(
      group_id AS id
    )
)
EDGE TABLES (
  orders AS `from`
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES `Order`(order_id)
    DESTINATION KEY(group_fk) REFERENCES `Group`(group_id)
);

-- warnings --
-- metric 'range' is not emitted: Spanner Graph has no MEASURE, so model-level metrics have no home in it
