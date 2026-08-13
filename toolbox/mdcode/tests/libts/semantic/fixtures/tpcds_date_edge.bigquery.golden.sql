CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.tpcds_model`
NODE TABLES (
  `tpcds.public.store_sales` AS store_sales
    KEY(ss_item_sk, ss_ticket_number)
    OPTIONS(description="Fact table containing all store sales transactions")
    PROPERTIES(
      ss_item_sk,
      ss_ticket_number,
      ss_customer_sk,
      ss_store_sk,
      ss_quantity OPTIONS(description="Quantity of items sold"),
      ss_sales_price OPTIONS(description="Sales price per unit"),
      ss_ext_sales_price OPTIONS(description="Extended sales price (quantity * price)"),
      ss_net_profit OPTIONS(description="Net profit from the sale")
    ),
  `tpcds.public.customer` AS customer
    KEY(c_customer_sk)
    OPTIONS(description="Customer dimension with demographic information")
    PROPERTIES(
      c_customer_sk,
      c_first_name OPTIONS(description="Customer first name"),
      c_last_name OPTIONS(description="Customer last name")
    ),
  `tpcds.public.item` AS item
    KEY(i_item_sk)
    OPTIONS(description="Item/Product dimension")
    PROPERTIES(
      i_item_sk,
      i_brand,
      i_category,
      i_current_price OPTIONS(description="Current price of the item")
    ),
  `tpcds.public.store` AS store
    KEY(s_store_sk)
    OPTIONS(description="Store dimension with location attributes")
    PROPERTIES(
      s_store_sk,
      s_store_name,
      s_city,
      s_state,
      s_number_employees OPTIONS(description="Number of employees at the store")
    )
)
EDGE TABLES (
  `tpcds.public.store_sales` AS store_sales_to_customer
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_customer_sk) REFERENCES customer(c_customer_sk),
  `tpcds.public.store_sales` AS store_sales_to_item
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_item_sk) REFERENCES item(i_item_sk),
  `tpcds.public.store_sales` AS store_sales_to_store
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_store_sk) REFERENCES store(s_store_sk)
)
OPTIONS(description="TPC-DS retail model");

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- dataset 'date_dim': no primary_key; the entity's KEY will be empty (invalid for graph generation)
-- entity 'date_dim': empty KEY (no primary key); node table skipped, as a graph node requires a KEY
-- relationship 'store_sales_to_date_dim': references skipped entity 'date_dim'; edge omitted
