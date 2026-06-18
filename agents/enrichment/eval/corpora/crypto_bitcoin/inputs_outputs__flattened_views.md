# `inputs` and `outputs` — flattened transaction edges

Source: `bitcoin-etl` (`transaction_input`, `transaction_output`) —
https://github.com/blockchain-etl/bitcoin-etl
Source: `bigquery-public-data.crypto_bitcoin.inputs` / `.outputs` column semantics

## Purpose

`inputs` and `outputs` are **denormalized, one-row-per-edge** representations of
the repeated `transactions.inputs[]` and `transactions.outputs[]` arrays. They let
analysts query inputs/outputs directly without `UNNEST`ing the nested
`transactions` records. (In the public dataset they are exposed as views over
`transactions`; here they are enumerated as their own tables.)

## `inputs` — outputs being spent (one row per input)

Each row is a single transaction input:

- **`transaction_hash`** — the spending transaction (→ `transactions.hash`).
- **`block_hash`** / **`block_number`** / **`block_timestamp`** — the block context.
- **`index`** — position of this input within its transaction.
- **`spent_transaction_hash`** + **`spent_output_index`** — reference to the
  **previous transaction's output** being consumed (the UTXO link).
- **`addresses`** (REPEATED), **`value`** — who owned the spent output and its
  amount.
- **`script_asm`** / **`script_hex`** / **`sequence`** / **`required_signatures`** —
  the unlocking script and spend conditions.

## `outputs` — newly created outputs (one row per output)

Each row is a single transaction output:

- **`transaction_hash`** — the creating transaction (→ `transactions.hash`).
- **`block_hash`** / **`block_number`** / **`block_timestamp`** — block context.
- **`index`** — position of this output within its transaction; an
  (`transaction_hash`, `index`) pair is what a later input's
  (`spent_transaction_hash`, `spent_output_index`) points at.
- **`addresses`** (REPEATED), **`value`** — recipient address(es) and amount.
- **`script_asm`** / **`script_hex`** / **`required_signatures`** — the locking
  script.

## Relationships

`inputs`/`outputs` join to `transactions` on `transaction_hash` and to `blocks` on
`block_hash`/`block_number`. An `outputs` row is later referenced by an `inputs`
row (`spent_transaction_hash` + `spent_output_index`), reconstructing the flow of
coins across the UTXO graph.

---
*Source: bitcoin-etl transaction_input/transaction_output + crypto_bitcoin semantics — factual.*
