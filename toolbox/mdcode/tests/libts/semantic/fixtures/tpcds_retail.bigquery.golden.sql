CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.tpcds_retail_model`
NODE TABLES (
  `tpcds.public.store_sales` AS store_sales
    KEY(ss_item_sk, ss_ticket_number)
    OPTIONS(description="Fact table containing all store sales transactions", synonyms=["sales transactions", "store purchases", "retail sales", "POS data"])
    PROPERTIES(
      ss_sold_date_sk OPTIONS(description="Foreign key to date dimension", synonyms=["sale date", "transaction date"]),
      ss_item_sk OPTIONS(description="Foreign key to item dimension", synonyms=["product", "item"]),
      ss_customer_sk OPTIONS(description="Foreign key to customer dimension", synonyms=["customer", "buyer"]),
      ss_store_sk OPTIONS(description="Foreign key to store dimension", synonyms=["store", "location"]),
      ss_quantity OPTIONS(description="Quantity of items sold", synonyms=["units sold", "quantity"]),
      ss_sales_price OPTIONS(description="Sales price per unit", synonyms=["unit price", "price"]),
      ss_ext_sales_price OPTIONS(description="Extended sales price (quantity * price)", synonyms=["total price", "line total"]),
      ss_net_profit OPTIONS(description="Net profit from the sale", synonyms=["profit", "margin"]),
      MEASURE(SUM(ss_ext_sales_price)) AS total_sales OPTIONS(description="Total sales revenue across all transactions", synonyms=["total revenue", "gross sales", "sales amount"]),
      MEASURE(SUM(ss_net_profit)) AS total_profit OPTIONS(description="Total net profit from store sales", synonyms=["net profit", "total earnings", "profit"]),
      MEASURE(SUM(ss_ext_sales_price)) AS sales_by_brand OPTIONS(description="Total sales by brand (requires grouping by item.i_brand)", synonyms=["brand sales", "brand performance", "brand revenue"])
    ),
  `tpcds.public.date_dim` AS date_dim
    KEY(d_date_sk)
    OPTIONS(description="Date dimension with calendar attributes", synonyms=["calendar", "dates", "time periods"])
    PROPERTIES(
      d_date_sk OPTIONS(description="Surrogate key for date"),
      d_date OPTIONS(description="Time dimension.\n\nActual date value", synonyms=["date", "calendar date"]),
      d_year OPTIONS(description="Time dimension.\n\nYear", synonyms=["year"]),
      d_quarter_name OPTIONS(description="Time dimension.\n\nQuarter name (e.g., 2024Q1)", synonyms=["quarter", "fiscal quarter"]),
      d_month_name OPTIONS(description="Time dimension.\n\nMonth name", synonyms=["month"])
    ),
  `tpcds.public.customer` AS customer
    KEY(c_customer_sk)
    OPTIONS(description="Customer dimension with demographic information", synonyms=["customers", "shoppers", "buyers"])
    PROPERTIES(
      c_customer_sk OPTIONS(description="Surrogate key for customer"),
      c_customer_id OPTIONS(description="Business key for customer", synonyms=["customer ID", "customer number"]),
      c_first_name OPTIONS(description="Customer first name"),
      c_last_name OPTIONS(description="Customer last name"),
      c_first_name || ' ' || c_last_name AS customer_full_name OPTIONS(description="Customer full name (computed field)", synonyms=["full name", "customer name"]),
      c_email_address OPTIONS(description="Customer email address", synonyms=["email", "contact"])
    ),
  `tpcds.public.item` AS item
    KEY(i_item_sk)
    OPTIONS(description="Item/Product dimension with product attributes", synonyms=["products", "items", "merchandise"])
    PROPERTIES(
      i_item_sk OPTIONS(description="Surrogate key for item"),
      i_item_id OPTIONS(description="Business key for item", synonyms=["item ID", "product ID", "SKU"]),
      i_item_desc OPTIONS(description="Item description", synonyms=["product description", "item name"]),
      i_brand OPTIONS(description="Brand name", synonyms=["brand", "manufacturer"]),
      i_category OPTIONS(description="Item category", synonyms=["product category", "department"]),
      i_current_price OPTIONS(description="Current price of the item", synonyms=["price", "list price"])
    ),
  `tpcds.public.store` AS store
    KEY(s_store_sk)
    OPTIONS(description="Store dimension with location and store attributes", synonyms=["stores", "retail locations", "branches"])
    PROPERTIES(
      s_store_sk OPTIONS(description="Surrogate key for store"),
      s_store_id OPTIONS(description="Business key for store", synonyms=["store ID", "store number"]),
      s_store_name OPTIONS(description="Store name", synonyms=["store name", "location name"]),
      s_city OPTIONS(description="City where store is located", synonyms=["city", "location"]),
      s_state OPTIONS(description="State where store is located", synonyms=["state", "region"]),
      s_number_employees OPTIONS(description="Number of employees at the store", synonyms=["employee count", "staff size"])
    )
)
EDGE TABLES (
  `tpcds.public.store_sales` AS store_sales_to_date
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_sold_date_sk) REFERENCES date_dim(d_date_sk)
    OPTIONS(synonyms=["sales date relationship", "when sale occurred"]),
  `tpcds.public.store_sales` AS store_sales_to_customer
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_customer_sk) REFERENCES customer(c_customer_sk)
    OPTIONS(synonyms=["customer purchase relationship", "who bought"]),
  `tpcds.public.store_sales` AS store_sales_to_item
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_item_sk) REFERENCES item(i_item_sk)
    OPTIONS(synonyms=["product sold relationship", "what was sold"]),
  `tpcds.public.store_sales` AS store_sales_to_store
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_store_sk) REFERENCES store(s_store_sk)
    OPTIONS(synonyms=["store location relationship", "where sale occurred"])
);

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- metric 'customer_lifetime_value' spans multiple tables (store_sales, customer); skipped (cannot be a single MEASURE)
-- metric 'store_productivity' spans multiple tables (store_sales, store); skipped (cannot be a single MEASURE)
