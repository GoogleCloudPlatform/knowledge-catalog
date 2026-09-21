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

## Running an action

Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `default`.

- Store: none.
- Executor: `sql`

No action in this model can be run under this profile:

- `PlaceOrder` -- Model 'sales' has no store under profile 'default'.

Report that rather than retrying.

## How a call ends

Settle every rule that gates an action before you perform it, not after. A rule settled afterwards is not a gate: the write has landed and there is nothing left for the rule to prevent. Refusing first is what makes a refusal cost nothing.

A call ends in one of these. Do not collapse them into worked and did not work:

- **Applied.** The write landed. Say what changed, and say how many rows changed.
- **Refused.** You did not perform the write, and the reason says why. Repeat the reason plainly. If it says a person has to decide, say so and stop -- you cannot approve it yourself, and rephrasing the request to get past a rule is the one thing you must not do.
- **Applied with warnings.** The change landed and an advisory rule still went unmet. Report both. Reporting only the success tells the caller the write met every rule the model states, which is the one thing it did not.

If you sent a statement and cannot tell whether it landed, that is a fourth thing and not a failure: say so, and say what to read to find out. Do not send it again. A retry that succeeds where the first attempt may also have succeeded leaves two of whatever the caller asked for one of.
