CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.reserved_words`
NODE TABLES (
  `proj.ds.orders` AS `Order`
    KEY(order_id)
    PROPERTIES(
      order_id AS id,
      group_fk AS groupId,
      `order` AS rank,
      MEASURE(COUNT(id)) AS `range`
    ),
  `proj.ds.groups` AS `Group`
    KEY(group_id)
    PROPERTIES(
      group_id AS id
    )
)
EDGE TABLES (
  `proj.ds.orders` AS `from`
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES `Order`(order_id)
    DESTINATION KEY(group_fk) REFERENCES `Group`(group_id)
);

-- warnings --
-- (none)
