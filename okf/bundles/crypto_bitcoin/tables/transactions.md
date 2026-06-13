---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin/tables/transactions
title: Bitcoin Transactions
description: A comprehensive table detailing all transactions on the Bitcoin blockchain.
tags:
- bitcoin
- blockchain
- transactions
- crypto
- public data
- etl
timestamp: '2026-05-28T22:45:04+00:00'
---

The `transactions` table in the [crypto_bitcoin](../datasets/crypto_bitcoin.md) dataset provides a complete record of every transaction ever processed on the Bitcoin blockchain. Each row represents a single transaction, offering granular details such as its hash, size, associated [block](blocks.md) information (hash, number, timestamp), and the total input and output values. Importantly, it includes detailed arrays for both [inputs](inputs.md) and [outputs](outputs.md), each specifying spent transaction details, script information, involved addresses, and values. This table is essential for in-depth analysis of transaction flows, tracing funds, and understanding the economic activity within the Bitcoin network. The grain is one row per transaction, with data spanning the entire history of the Bitcoin blockchain, partitioned by `block_timestamp_month`.

# Schema
- `hash` STRING REQUIRED: The hash of this transaction
- `size` INTEGER: The size of this transaction in bytes
- `virtual_size` INTEGER: The virtual transaction size (differs from size for witness transactions)
- `version` INTEGER: Protocol version specified in block which contained this transaction
- `lock_time` INTEGER: Earliest time that miners can include the transaction in their hashing of the Merkle root to attach it in the latest block of the blockchain
- `block_hash` STRING REQUIRED: Hash of the block which contains this transaction
- `block_number` INTEGER REQUIRED: Number of the block which contains this transaction
- `block_timestamp` TIMESTAMP REQUIRED: Timestamp of the block which contains this transaction
- `block_timestamp_month` DATE REQUIRED: Month of the block which contains this transaction
- `input_count` INTEGER: The number of inputs in the transaction
- `output_count` INTEGER: The number of outputs in the transaction
- `input_value` NUMERIC: Total value of inputs in the transaction
- `output_value` NUMERIC: Total value of outputs in the transaction
- `is_coinbase` BOOLEAN: True if this transaction is a coinbase transaction
- `fee` NUMERIC: The fee paid by this transaction
- `inputs` RECORD REPEATED: Transaction inputs
  - `index` INTEGER REQUIRED: 0-indexed number of an input within a transaction
  - `spent_transaction_hash` STRING: The hash of the transaction which contains the output that this input spends
  - `spent_output_index` INTEGER: The index of the output this input spends
  - `script_asm` STRING: Symbolic representation of the bitcoin's script language op-codes
  - `script_hex` STRING: Hexadecimal representation of the bitcoin's script language op-codes
  - `sequence` INTEGER: A number intended to allow unconfirmed time-locked transactions to be updated before being finalized
  - `required_signatures` INTEGER: The number of signatures required to authorize the spent output
  - `type` STRING: The address type of the spent output
  - `addresses` STRING REPEATED: Addresses which own the spent output
  - `value` NUMERIC: The value in base currency attached to the spent output
- `outputs` RECORD REPEATED: Transaction outputs
  - `index` INTEGER REQUIRED: 0-indexed number of an output within a transaction
  - `script_asm` STRING: Symbolic representation of the bitcoin's script language op-codes
  - `script_hex` STRING: Hexadecimal representation of the bitcoin's script language op-codes
  - `required_signatures` INTEGER: The number of signatures required to authorize spending of this output
  - `type` STRING: The address type of the output
  - `addresses` STRING REPEATED: Addresses which own this output
  - `value` NUMERIC: The value in base currency attached to this output

# Common query patterns
```sql
-- Get the total number of transactions per day
SELECT
    DATE(block_timestamp) AS transaction_date,
    COUNT(hash) AS transaction_count
FROM
    `bigquery-public-data.crypto_bitcoin.transactions`
WHERE
    block_timestamp BETWEEN '2023-01-01' AND '2023-01-31'
GROUP BY
    transaction_date
ORDER BY
    transaction_date DESC;
```
```sql
-- Find transactions involving a specific address as an output
SELECT
    t.hash AS transaction_hash,
    t.block_timestamp
FROM
    `bigquery-public-data.crypto_bitcoin.transactions` AS t,
    UNNEST(t.outputs) AS output
WHERE
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' IN UNNEST(output.addresses)
LIMIT 10;
```
```sql
-- Calculate the total fees collected in a given month
SELECT
    FORMAT_TIMESTAMP('%Y-%m', block_timestamp) AS transaction_month,
    SUM(fee) AS total_fee
FROM
    `bigquery-public-data.crypto_bitcoin.transactions`
WHERE
    block_timestamp BETWEEN '2023-01-01' AND '2023-01-31'
GROUP BY
    transaction_month;
```
```sql
-- Find duplicate transactions (anomaly detection)
SELECT
   *
FROM (
 SELECT
   hash,
   COUNT(hash) AS dup_transaction_count
 FROM
   `bigquery-public-data.crypto_bitcoin.transactions`
 GROUP BY
   hash)
WHERE
 dup_transaction_count > 1
```

# Citations
[1] [Bitcoin Transactions](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin/tables/transactions)
[2] [Bitcoin ETL](https://github.com/blockchain-etl/bitcoin-etl)
[3] [Bitcoin in BigQuery: blockchain analytics on public data](https://cloud.google.com/blog/products/gcp/bitcoin-in-bigquery-blockchain-analytics-on-public-data)
