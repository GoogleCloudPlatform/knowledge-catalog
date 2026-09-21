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

This skill offers writes, not reads. When you are given a name or a description where an action wants a key, the key has to come from somewhere else: ask the caller, or read the store directly. A key that matches no record costs you the call rather than the data: a statement that writes no rows fails the action and rolls the whole transaction back, so nothing is half-applied and nothing is silently skipped. Guessing a key is therefore safe to be wrong about, and not safe to be right about by accident.

## Running an action

Everything above is true of this model wherever it is deployed. This section is not: it describes the binding this skill was generated from, which is profile `default`.

- Store: none.
- Executor: `sql`

No action in this model can be run under this profile:

- `PlaceOrder` -- Model 'sales' has no store under profile 'default'.

Report that rather than retrying.

## What happens when you call one

Every rule is settled before the write opens a transaction. So a refusal leaves the store exactly as it was, and no rule ever sees the write it gates. There is nothing to undo after a refusal.

A call comes back in one of three states, and they are not two:

- **Applied.** The write landed. Say what changed.
- **Refused.** The write did not happen, and the reason says why. Repeat the reason plainly. If it says a person has to decide, say so and stop -- you cannot approve it yourself, and rephrasing the request to get past a rule is the one thing you must not do.
- **Unknown.** The statements ran and the commit could not report its outcome. The write may or may not have landed. Do not retry: say that the outcome is unknown and what to check.

A call can also come back applied **and** carry warnings. That means the change landed and a rule still went unmet, or went unchecked. Report both. Reporting only the success tells the caller the write met every rule the model states, which is the one thing it did not.
