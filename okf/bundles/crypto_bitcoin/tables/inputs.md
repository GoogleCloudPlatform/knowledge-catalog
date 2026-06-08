---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin/tables/inputs
title: Bitcoin Transaction Inputs
description: Details about transaction inputs on the Bitcoin blockchain.
tags:
- bitcoin
- blockchain
- cryptocurrency
- transactions
- inputs
- etl
timestamp: '2026-05-28T22:44:24+00:00'
---

This table, part of the public [crypto_bitcoin](/datasets/crypto_bitcoin.md) dataset, contains detailed information about every input used in Bitcoin transactions. Each row represents a single transaction input, which typically references an unspent output from a previous transaction. This table is crucial for tracing the flow of Bitcoin and understanding the history of transactions. It records where the coins originated (`spent_transaction_hash` and `spent_output_index`) and the associated `value` transferred. This table can be joined with the [transactions](/tables/transactions.md) table on `transaction_hash` and [outputs](/tables/outputs.md) to reconstruct the full transaction graph.

# Schema

*   `transaction_hash`: STRING
*   `block_hash`: STRING
*   `block_number`: INTEGER
*   `block_timestamp`: TIMESTAMP
*   `index`: INTEGER
*   `spent_transaction_hash`: STRING
*   `spent_output_index`: INTEGER
*   `script_asm`: STRING
*   `script_hex`: STRING
*   `sequence`: INTEGER
*   `required_signatures`: INTEGER
*   `type`: STRING
*   `addresses`: REPEATED STRING
*   `value`: NUMERIC

# Common query patterns

```sql
SELECT *
FROM `bigquery-public-data.crypto_bitcoin.inputs`
WHERE transaction_hash = 'YOUR_TRANSACTION_HASH_HERE'
LIMIT 10
```

```sql
SELECT
    block_number,
    SUM(value) AS total_input_value
FROM `bigquery-public-data.crypto_bitcoin.inputs`
WHERE block_number = 600000 -- Example block number
GROUP BY block_number
```

```sql
SELECT DISTINCT
    address
FROM `bigquery-public-data.crypto_bitcoin.inputs`,
    UNNEST(addresses) AS address
WHERE block_timestamp >= '2023-01-01'
LIMIT 10
```

# Citations

[1] [BigQuery Table: inputs](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin/tables/inputs)
[2] [blockchain-etl/bitcoin-etl](https://github.com/blockchain-etl/bitcoin-etl)
