# `transactions` — transactions and the UTXO model

Source: `bitcoin-etl` schema (`transactions.json`, `transaction_input`,
`transaction_output`) — https://github.com/blockchain-etl/bitcoin-etl
Source: `bigquery-public-data.crypto_bitcoin.transactions` column semantics

## Purpose

`transactions` holds **one row per Bitcoin transaction**. Each transaction
belongs to exactly one block and moves value from a set of inputs to a set of
outputs. It is the central fact table of the dataset.

## Belongs to a block (cross-table relationship)

- **`block_hash`** (STRING, REQUIRED) → `blocks.hash`
- **`block_number`** (INTEGER, REQUIRED) → `blocks.number`
- **`block_timestamp`** (TIMESTAMP, REQUIRED) — the containing block's time;
  **`block_timestamp_month`** (DATE) is the **partitioning** column.

## The UTXO model (nested inputs & outputs)

Bitcoin uses the **Unspent Transaction Output (UTXO)** model. A transaction
consumes outputs of earlier transactions as its inputs and creates new outputs:

- **`inputs`** (RECORD, REPEATED) — the outputs being spent. Each input has
  **`spent_transaction_hash`** and **`spent_output_index`**, which reference a
  **prior transaction's output** (`spent_transaction_hash` → an earlier
  `transactions.hash`). Inputs also carry `addresses`, `value`, `script_asm`,
  `script_hex`, `sequence`, and `required_signatures`.
- **`outputs`** (RECORD, REPEATED) — the newly-created spendable outputs. Each has
  an `index`, the owning `addresses`, a `value`, and the locking script
  (`script_asm` / `script_hex`).

This self-referential chain (an input points at a previous transaction's output)
is what links transactions together over time.

## Value and fees

- **`input_value`** — total value of all inputs; **`output_value`** — total value
  of all outputs (base currency / satoshis).
- **`fee`** — the miner fee, equal to **`input_value` − `output_value`**.
- **`is_coinbase`** (BOOLEAN) — true for the **coinbase transaction**, the first
  transaction in each block that creates new coins (the block reward) and has no
  real spent inputs.
- **`input_count`** / **`output_count`** — number of inputs / outputs.
- **`hash`** (REQUIRED) — the transaction's unique id; `size`, `virtual_size`,
  `version`, `lock_time` describe its encoding and time-lock.

## Relationships

`transactions` → `blocks` (block_hash/block_number); `transactions.inputs[]` /
`outputs[]` are denormalized into the `inputs` / `outputs` tables; inputs
reference prior transactions' outputs (UTXO graph).

---
*Source: bitcoin-etl transactions schema + crypto_bitcoin column semantics — factual.*
