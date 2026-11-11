CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.mixed_keys`
NODE TABLES (
  `sqlgen-testing.demo.facts` AS facts
    KEY(id)
    PROPERTIES(
      id,
      nokey_id
    )
);

-- warnings --
-- entity 'nokey': empty KEY (no primary key); node table skipped, as a graph node requires a KEY
-- relationship 'facts_to_nokey': references skipped entity 'nokey'; edge omitted
