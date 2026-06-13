---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin/tables/outputs
title: Outputs
description: Outputs from all transactions in the Bitcoin blockchain.
tags:
- bitcoin
- blockchain
- transactions
- outputs
- etl
timestamp: '2026-05-28T22:44:32+00:00'
---

The `outputs` table contains records of all transaction outputs within the Bitcoin blockchain. Each row in this table represents a single output from a Bitcoin transaction, detailing the amount transferred, the destination addresses, and other script-related information. This table is crucial for understanding the flow of Bitcoin and analyzing transaction patterns, especially when linked with the `[transactions](transactions.md)` and `[inputs](inputs.md)` tables.

# Schema

- `transaction_hash`: The hash of the transaction this output belongs to.
- `block_hash`: The hash of the block containing this transaction.
- `block_number`: The number of the block containing this transaction.
- `block_timestamp`: The timestamp of the block containing this transaction.
- `index`: The zero-based index of this output within its transaction.
- `script_asm`: The script in assembly format.
- `script_hex`: The script in hexadecimal format.
- `required_signatures`: The number of signatures required to spend this output.
- `type`: The type of the output script.
- `addresses`: (REPEATED) Array of destination addresses for this output.
- `value`: The value of the output in satoshis.

# Common query patterns

```sql
SELECT
  t.*
FROM
  `bigquery-public-data.crypto_bitcoin.outputs` AS t
WHERE
  t.transaction_hash = 'some_transaction_hash'
```

```sql
SELECT
  SUM(t.value) AS total_output_value
FROM
  `bigquery-public-data.crypto_bitcoin.outputs` AS t
WHERE
  t.block_number = 123456
```

```sql
SELECT
  t.type,
  COUNT(*) AS output_count
FROM
  `bigquery-public-data.crypto_bitcoin.outputs` AS t
WHERE
  t.block_timestamp BETWEEN TIMESTAMP('2023-01-01') AND TIMESTAMP('2023-01-31')
GROUP BY
  t.type
ORDER BY
  output_count DESC
```

# Citations

[1] [Outputs Table](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin/tables/outputs)
[2] [Bitcoin ETL on GitHub](https://github.com/blockchain-etl/bitcoin-etl)
