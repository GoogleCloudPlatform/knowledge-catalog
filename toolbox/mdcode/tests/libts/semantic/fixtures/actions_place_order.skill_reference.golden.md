# PlaceOrder

Action `PlaceOrder` of the `sales` model. As a tool it is named `place_order`.

Create an order for a customer

## Arguments

| Name | Type | Required | What to pass |
| --- | --- | --- | --- |
| `customer` | integer | yes | The customer's account number. |
| `quantity` | integer | yes | The quantity, as a whole number. |

## How to call it

Resolve the buyer to a customer before calling.

## Rules that apply to this call

Each is settled before anything is written, from the attempted call and, where the rule is about something on record, the record.

### OrderWithinCustomerCredit

On violation: `reject`

> The resulting orders.o_totalprice must not exceed the credit this customer has on record. That figure is not stated in the arguments, so read it before answering.

If it does not hold: An order cannot exceed the credit on record for this customer. Lower the quantity, or ask for a credit review.

## What it changes

| Concept | Operation | Fields |
| --- | --- | --- |
| `orders` | `create` | `o_orderkey`, `o_totalprice` |
| `orders_to_customer` | `create` | unspecified |
| `customer` | unspecified | unspecified |
