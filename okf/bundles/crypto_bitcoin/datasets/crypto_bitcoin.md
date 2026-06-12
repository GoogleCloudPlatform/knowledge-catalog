---
type: BigQuery Dataset
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin
title: Cryptocurrency Bitcoin
description: This BigQuery public dataset contains a complete history of the Bitcoin
  blockchain and updates every 10 minutes.
tags:
- cryptocurrency
- bitcoin
- blockchain
- public data
- gcp
- data-analytics
timestamp: '2026-05-28T22:44:47+00:00'
---

The `crypto_bitcoin` dataset provides a comprehensive and up-to-date record of the entire Bitcoin blockchain. It includes detailed information about [blocks](/tables/blocks.md), [transactions](/tables/transactions.md), transaction [inputs](/tables/inputs.md), and [outputs](/tables/outputs.md). This dataset is part of the BigQuery Public Datasets program, making it freely accessible for analysis and research into Bitcoin's operations, economics, and historical trends. Researchers, developers, and enthusiasts can use this data to understand transaction patterns, network activity, and the overall state of the Bitcoin network.

# Schema

This dataset contains the following tables, providing a complete history of the Bitcoin blockchain:

*   [blocks](/tables/blocks.md)
*   [inputs](/tables/inputs.md)
*   [outputs](/tables/outputs.md)
*   [transactions](/tables/transactions.md)

# Common query patterns

```sql
-- Count the total number of blocks in the Bitcoin blockchain
SELECT
    COUNT(*)
FROM
    `bigquery-public-data.crypto_bitcoin.blocks`;
```

```sql
-- Get the total number of transactions over time
SELECT
    DATE(block_timestamp) AS transaction_date,
    COUNT(transaction_id) AS total_transactions
FROM
    `bigquery-public-data.crypto_bitcoin.transactions`
GROUP BY
    transaction_date
ORDER BY
    transaction_date DESC
LIMIT 100;
```

# Citations

[1] [BigQuery Public Dataset: crypto_bitcoin](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin)
[2] [Bitcoin in BigQuery: blockchain analytics on public data](https://cloud.google.com/blog/products/gcp/bitcoin-in-bigquery-blockchain-analytics-on-public-data)
