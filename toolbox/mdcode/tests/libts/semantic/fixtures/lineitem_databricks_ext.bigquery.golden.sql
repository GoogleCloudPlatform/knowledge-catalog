CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.lineitem`
NODE TABLES (

)
OPTIONS(description="Line item shipping metrics");

-- warnings --
-- dataset 'lineitem': no primary_key; the entity's KEY will be empty (invalid for graph generation)
-- field 'lineitem.line_number': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'DATABRICKS' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- dataset 'orders': no primary_key; the entity's KEY will be empty (invalid for graph generation)
-- metric 'revenue': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'DATABRICKS' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- metric 'revenue': expression references no known entity; it may not be placeable downstream
-- metric 'order_count': no 'BIGQUERY' or 'ANSI_SQL' dialect; keeping the 'DATABRICKS' expression as imported_expression (needs transpilation to 'BIGQUERY')
-- metric 'order_count': expression references no known entity; it may not be placeable downstream
-- entity 'lineitem': empty KEY (no primary key); node table skipped, as a graph node requires a KEY
-- entity 'orders': empty KEY (no primary key); node table skipped, as a graph node requires a KEY
-- every entity was skipped (empty KEY); the generated graph would be empty and invalid
-- metric 'revenue' references no known entity; skipped (cannot be a single MEASURE)
-- metric 'order_count' references no known entity; skipped (cannot be a single MEASURE)
-- relationship 'lineitem_to_orders': references skipped entity 'lineitem', 'orders'; edge omitted
