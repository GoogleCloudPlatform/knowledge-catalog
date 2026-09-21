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

Never invent an identifier. When you are given a name or a description where an action wants a key, ask the caller or read the store directly. Check every rule that gates an action before running it: when a rule says a write must not happen, refuse and explain why; when it says a person has to decide, say so and stop, because you cannot approve it yourself; when an advisory rule goes unmet, report both the change and the warning. Finish by saying what you changed.

## Finding a record

This skill offers writes, not reads. When you are given a name or a description where an action wants a key, the key has to come from somewhere else: ask the caller, or read the store directly. A key that matches no record does not announce itself: the statement runs, matches nothing, writes nothing, and comes back reporting zero rows rather than an error. Read that count. A write that changed no rows did not happen, however well the call went, and reporting it as done is the one mistake here that nothing else will catch.

To read the store directly, run a `SELECT` against it. If a shell is what you have:

```bash
gcloud spanner databases execute-sql d \
  --instance=i --project=p \
  --sql='SELECT ...'
```

Those are GoogleSQL statements. These are the whole of what there is to read, and the names to write in a statement are the names below -- not the model's own names, which follow each column for cross-reference:

```
orders -> orders
  column o_orderkey (String) = orders.o_orderkey
  column o_custkey (String) = orders.o_custkey
  column o_totalprice (String) = orders.o_totalprice
customer -> customer
  column c_custkey (Integer) = customer.c_custkey. The customer's account number.
  column c_name (String) = customer.c_name
```

## Running an action

Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `default`.

- Store: `p/i/d`
- Executor: `sql`

To perform one of these, run its GoogleSQL below against that store with the call's arguments bound to the named parameters. Run what is written and nothing else: this is what the model says the action is, and a statement composed instead of this one is a write nobody declared and no rule was written against.

### PlaceOrder

```sql
UPDATE orders SET o_totalprice = 0 WHERE 1 = 0
```

## How a call ends

Settle every rule that gates an action before you perform it, not after. A rule settled afterwards is not a gate: the write has landed and there is nothing left for the rule to prevent. Refusing first is what makes a refusal cost nothing.

A call ends in one of these. Do not collapse them into worked and did not work:

- **Applied.** The write landed. Say what changed, and say how many rows changed.
- **Refused.** You did not perform the write, and the reason says why. Repeat the reason plainly. If it says a person has to decide, say so and stop -- you cannot approve it yourself, and rephrasing the request to get past a rule is the one thing you must not do.
- **Applied with warnings.** The change landed and an advisory rule still went unmet. Report both. Reporting only the success tells the caller the write met every rule the model states, which is the one thing it did not.

If you sent a statement and cannot tell whether it landed, that is a fourth thing and not a failure: say so, and say what to read to find out. Do not send it again. A retry that succeeds where the first attempt may also have succeeded leaves two of whatever the caller asked for one of.
