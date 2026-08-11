CREATE OR REPLACE PROPERTY GRAPH `sqlgen-testing.demo.tpcds_retail_model`
NODE TABLES (
  `tpcds.public.store_sales` AS store_sales
    KEY(ss_item_sk, ss_ticket_number)
    OPTIONS(description="Fact table containing all store sales transactions\n\nSynonyms: sales transactions, store purchases, retail sales, POS data")
    PROPERTIES(
      ss_sold_date_sk OPTIONS(description="Foreign key to date dimension\n\nSynonyms: sale date, transaction date"),
      ss_item_sk OPTIONS(description="Foreign key to item dimension\n\nSynonyms: product, item"),
      ss_customer_sk OPTIONS(description="Foreign key to customer dimension\n\nSynonyms: customer, buyer"),
      ss_store_sk OPTIONS(description="Foreign key to store dimension\n\nSynonyms: store, location"),
      ss_quantity OPTIONS(description="Quantity of items sold\n\nSynonyms: units sold, quantity"),
      ss_sales_price OPTIONS(description="Sales price per unit\n\nSynonyms: unit price, price"),
      ss_ext_sales_price OPTIONS(description="Extended sales price (quantity * price)\n\nSynonyms: total price, line total"),
      ss_net_profit OPTIONS(description="Net profit from the sale\n\nSynonyms: profit, margin"),
      MEASURE(SUM(ss_ext_sales_price)) AS total_sales OPTIONS(description="Total sales revenue across all transactions\n\nSynonyms: total revenue, gross sales, sales amount"),
      MEASURE(SUM(ss_net_profit)) AS total_profit OPTIONS(description="Total net profit from store sales\n\nSynonyms: net profit, total earnings, profit"),
      MEASURE(SUM(ss_ext_sales_price)) AS sales_by_brand OPTIONS(description="Total sales by brand (requires grouping by item.i_brand)\n\nSynonyms: brand sales, brand performance, brand revenue")
    ),
  `tpcds.public.date_dim` AS date_dim
    KEY(d_date_sk)
    OPTIONS(description="Date dimension with calendar attributes\n\nSynonyms: calendar, dates, time periods")
    PROPERTIES(
      d_date_sk OPTIONS(description="Surrogate key for date"),
      d_date OPTIONS(description="Time dimension.\n\nActual date value\n\nSynonyms: date, calendar date"),
      d_year OPTIONS(description="Time dimension.\n\nYear\n\nSynonyms: year"),
      d_quarter_name OPTIONS(description="Time dimension.\n\nQuarter name (e.g., 2024Q1)\n\nSynonyms: quarter, fiscal quarter"),
      d_month_name OPTIONS(description="Time dimension.\n\nMonth name\n\nSynonyms: month")
    ),
  `tpcds.public.customer` AS customer
    KEY(c_customer_sk)
    OPTIONS(description="Customer dimension with demographic information\n\nSynonyms: customers, shoppers, buyers")
    PROPERTIES(
      c_customer_sk OPTIONS(description="Surrogate key for customer"),
      c_customer_id OPTIONS(description="Business key for customer\n\nSynonyms: customer ID, customer number"),
      c_first_name OPTIONS(description="Customer first name"),
      c_last_name OPTIONS(description="Customer last name"),
      c_first_name || ' ' || c_last_name AS customer_full_name OPTIONS(description="Customer full name (computed field)\n\nSynonyms: full name, customer name"),
      c_email_address OPTIONS(description="Customer email address\n\nSynonyms: email, contact")
    ),
  `tpcds.public.item` AS item
    KEY(i_item_sk)
    OPTIONS(description="Item/Product dimension with product attributes\n\nSynonyms: products, items, merchandise")
    PROPERTIES(
      i_item_sk OPTIONS(description="Surrogate key for item"),
      i_item_id OPTIONS(description="Business key for item\n\nSynonyms: item ID, product ID, SKU"),
      i_item_desc OPTIONS(description="Item description\n\nSynonyms: product description, item name"),
      i_brand OPTIONS(description="Brand name\n\nSynonyms: brand, manufacturer"),
      i_category OPTIONS(description="Item category\n\nSynonyms: product category, department"),
      i_current_price OPTIONS(description="Current price of the item\n\nSynonyms: price, list price")
    ),
  `tpcds.public.store` AS store
    KEY(s_store_sk)
    OPTIONS(description="Store dimension with location and store attributes\n\nSynonyms: stores, retail locations, branches")
    PROPERTIES(
      s_store_sk OPTIONS(description="Surrogate key for store"),
      s_store_id OPTIONS(description="Business key for store\n\nSynonyms: store ID, store number"),
      s_store_name OPTIONS(description="Store name\n\nSynonyms: store name, location name"),
      s_city OPTIONS(description="City where store is located\n\nSynonyms: city, location"),
      s_state OPTIONS(description="State where store is located\n\nSynonyms: state, region"),
      s_number_employees OPTIONS(description="Number of employees at the store\n\nSynonyms: employee count, staff size")
    )
)
EDGE TABLES (
  `tpcds.public.store_sales` AS store_sales_to_date
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_sold_date_sk) REFERENCES date_dim(d_date_sk)
    OPTIONS(description="Synonyms: sales date relationship, when sale occurred"),
  `tpcds.public.store_sales` AS store_sales_to_customer
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_customer_sk) REFERENCES customer(c_customer_sk)
    OPTIONS(description="Synonyms: customer purchase relationship, who bought"),
  `tpcds.public.store_sales` AS store_sales_to_item
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_item_sk) REFERENCES item(i_item_sk)
    OPTIONS(description="Synonyms: product sold relationship, what was sold"),
  `tpcds.public.store_sales` AS store_sales_to_store
    KEY(ss_item_sk, ss_ticket_number)
    SOURCE KEY(ss_item_sk, ss_ticket_number) REFERENCES store_sales(ss_item_sk, ss_ticket_number)
    DESTINATION KEY(ss_store_sk) REFERENCES store(s_store_sk)
    OPTIONS(description="Synonyms: store location relationship, where sale occurred")
)
OPTIONS(description="TPC-DS retail semantic model for sales and customer analytics\n\nUse this semantic model for retail analytics. It provides comprehensive sales, customer, product, and store data. The model supports time-based analysis, customer segmentation, product performance, and store operations metrics.");

-- warnings --
-- note: no 'BIGQUERY' dialect for one or more expressions; using the portable 'ANSI_SQL' dialect verbatim ('BIGQUERY' accepts the ANSI core subset — supply 'BIGQUERY' variants only for BIGQUERY-specific SQL)
-- metric 'customer_lifetime_value' spans multiple tables (store_sales, customer); skipped (cannot be a single MEASURE)
-- metric 'store_productivity' spans multiple tables (store_sales, store); skipped (cannot be a single MEASURE)
