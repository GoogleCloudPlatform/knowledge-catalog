---
name: "sales"
description: "Sales orders with customer attributes. Declares 1 action: PlaceOrder. Use when a request asks to change this data rather than only read it."
---

# sales

Sales orders with customer attributes

## What you can do here

Each action below has a reference page with the arguments it takes, the rules that gate it, and what it changes. Read the page for an action before you call it.

| Action | What it does | Reference |
| --- | --- | --- |
| `PlaceOrder` | Create an order for a customer | `references/place-order.md` |

## How this model wants to be used

Never invent an identifier. When you are given a name or a description where an action wants a key, ask the caller or read the store directly. When a tool reports that a write did not happen, read the reason it gives and repeat it plainly; if it says a person has to decide, say so and stop, because you cannot approve it yourself. When a write did happen and the tool returns warnings, the change landed and a rule still went unmet or unchecked: report both, because nobody else will. Finish by saying what you changed.

## Finding a record

This skill offers writes, not reads. When you are given a name or a description where an action wants a key, the key has to come from somewhere else: ask the caller, or read the store directly.

To read the store directly:

```bash
gcloud spanner databases execute-sql d \
  --instance=i --project=p \
  --sql='SELECT ...'
```

Those are GoogleSQL statements. These tables are the whole of what there is to read, and the names to write in a statement are the table and column names below -- not the model's own names, which follow each column for cross-reference:

```
orders -> table orders
  column o_orderkey (String) = orders.o_orderkey
  column o_custkey (String) = orders.o_custkey
  column o_totalprice (String) = orders.o_totalprice
customer -> table customer
  column c_custkey (Integer) = customer.c_custkey. The customer's account number.
  column c_name (String) = customer.c_name
```

## Running an action

Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `default`.

- Store: `p/i/d`
- Executor: `mcp`

No action in this model can be run under this profile:

- `PlaceOrder` -- Action 'PlaceOrder' is executed by MCP, which runs outside this transaction and could not be rolled back if the commit failed. Supply a handler that performs the write as DML, or declare the action with a 'sql' executor.

Report that rather than retrying.

## What happens when you call one

Every rule is settled before the write opens a transaction. So a refusal leaves the store exactly as it was, and no rule ever sees the write it gates. There is nothing to undo after a refusal.

A call comes back in one of three states, and they are not two:

- **Applied.** The write landed. Say what changed.
- **Refused.** The write did not happen, and the reason says why. Repeat the reason plainly. If it says a person has to decide, say so and stop -- you cannot approve it yourself, and rephrasing the request to get past a rule is the one thing you must not do.
- **Unknown.** The statements ran and the commit could not report its outcome. The write may or may not have landed. Do not retry: say that the outcome is unknown and what to check.

A call can also come back applied **and** carry warnings. That means the change landed and a rule still went unmet, or went unchecked. Report both. Reporting only the success tells the caller the write met every rule the model states, which is the one thing it did not.
