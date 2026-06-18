# `blocks` — block-level chain data

Source: `bitcoin-etl` schema (`blocks.json`) — https://github.com/blockchain-etl/bitcoin-etl
Source: `bigquery-public-data.crypto_bitcoin.blocks` column semantics

## Purpose

`blocks` holds **one row per block** in the Bitcoin blockchain. A block is the
unit of confirmation: miners batch transactions into a block and append it to the
chain. This table is the parent that `transactions` references.

## Key columns

- **`hash`** (STRING, REQUIRED) — the block hash; the unique identifier of the
  block. `transactions.block_hash` joins back to this.
- **`number`** (INTEGER, REQUIRED) — the **block height**: its sequential position
  in the chain (the genesis block is number 0). `transactions.block_number`
  joins back to this.
- **`timestamp`** (TIMESTAMP, REQUIRED) — block creation time from the block
  header. **`timestamp_month`** (DATE) is the month of that timestamp and is the
  table's **partitioning** column for efficient time-range scans.
- **`merkle_root`** (STRING) — the root of the Merkle tree whose leaves are the
  block's transaction hashes; it cryptographically commits to every transaction
  in the block.
- **`transaction_count`** (INTEGER) — number of transactions included in the block.
- **`size`** / **`stripped_size`** / **`weight`** — block size in bytes; stripped
  size excludes witness (SegWit) data; weight = 3×base size + total size.
- **`version`**, **`nonce`**, **`bits`** — block-header fields. `nonce` and `bits`
  relate to proof-of-work: `bits` encodes the difficulty threshold, `nonce` is the
  value miners vary to find a valid hash.
- **`coinbase_param`** — arbitrary data from the block's coinbase transaction.

## Relationships

`blocks` is referenced by `transactions` (via `block_hash` / `block_number`).
Counting transactions per block, or joining blocks to transactions on the block
hash, are the canonical analytical patterns.

---
*Source: bitcoin-etl blocks schema + crypto_bitcoin column semantics — factual.*
