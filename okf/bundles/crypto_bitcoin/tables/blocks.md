---
type: BigQuery Table
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin/tables/blocks
title: Bitcoin Blocks Table
description: Details about the Bitcoin Blocks BigQuery table, including its schema.
tags:
- bitcoin
- bigquery
- blocks
- blockchain
timestamp: '2026-05-28T22:43:59+00:00'
---

# Schema

| Field | Type |
| --- | --- |
| hash | hex_string |
| size | bigint |
| stripped_size | bigint |
| weight | bigint |
| number | bigint |
| version | bigint |
| merkle_root | hex_string |
| timestamp | bigint |
| nonce | hex_string |
| bits | hex_string |
| coinbase_param | hex_string |
| transaction_count | bigint |

# Citations
- https://github.com/blockchain-etl/bitcoin-etl
