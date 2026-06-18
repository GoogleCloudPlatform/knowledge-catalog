# Bitcoin on BigQuery — dataset overview

Source: `bigquery-public-data.crypto_bitcoin`
Source: `go/blockchain-etl` — https://github.com/blockchain-etl/bitcoin-etl
Source: Google Cloud blog — "Bitcoin in BigQuery: blockchain analytics on public data"

## What this dataset is

The `crypto_bitcoin` dataset is a continuously-updated mirror of the **Bitcoin
blockchain**, loaded into BigQuery by the open-source **`bitcoin-etl`** pipeline.
It lets analysts query the entire ledger with standard SQL instead of running a
full node. The schema mirrors `bitcoin-etl`'s output exactly.

## The four concepts and how they relate

The dataset is a **small set of tightly-related fact tables** — each row in one
table references rows in another, forming the on-chain graph:

- **`blocks`** — one row per block in the chain.
- **`transactions`** — one row per transaction; each transaction belongs to
  exactly one block and carries nested `inputs` and `outputs` arrays.
- **`inputs`** — a flattened view of every transaction input (one row per input).
- **`outputs`** — a flattened view of every transaction output (one row per output).

Key relationships (foreign keys in prose, not enforced by BigQuery):

- `transactions.block_hash` → `blocks.hash` and `transactions.block_number` →
  `blocks.number`: every transaction points back to the block that contains it.
- `inputs`/`outputs` are derived from the repeated `transactions.inputs[]` /
  `transactions.outputs[]` records, denormalized to one row per input/output.
- An input's `spent_transaction_hash` + `spent_output_index` reference a **prior
  transaction's output** — this is the **UTXO (Unspent Transaction Output)**
  model: today's inputs spend yesterday's outputs, chaining transactions together.

## Provenance & scale

Data is produced by `bitcoin-etl` and reflects the public ledger, so the
`transactions` table is very large (well over a billion rows). Monetary values
are denominated in the base currency unit (satoshis) as integers.

---
*Source: bitcoin-etl (blockchain-etl) + Google Cloud "Bitcoin in BigQuery" — factual.*
