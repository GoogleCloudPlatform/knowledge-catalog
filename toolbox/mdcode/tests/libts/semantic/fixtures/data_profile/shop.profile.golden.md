# Data profile

## Model `shop`

Binding profile `default`, checked 2026-01-01T00:00:00.000Z: 23 statement(s): 14 verified, 3 unverified, 6 contradicted.

| Status | Kind | Subject | Statement | Evidence |
|--------|------|---------|-----------|----------|
| contradicted | uniqueKey | Customer(email) | No two Customer rows share email. | 8 row(s) (0.8%) repeat another row's key, e.g. 'shared@example.com' x6, 'info@example.com' x4 |
| contradicted | orphans | Order.placedBy | Every Order.customer_id that is set matches a row of Customer (placedBy). | 14 of 4990 foreign-key value(s) (0.28%) match no Customer; 3 distinct, e.g. 'C-0999' x9, 'C-0998' x3, 'C-0997' x2 |
| contradicted | cardinality | Invoice.billedFor | Each Invoice has at most one Order through billedFor, and each Order at most one Invoice (one-to-one). | a row of Order is reached by up to 3 Invoice rows |
| contradicted | enumCoverage | Customer.segment | Every Customer.segment that is set is one of 'retail', 'wholesale' or 'online'. | 25 of 990 value(s) (2.53%) are outside the declared set, e.g. 'Retail' x20, 'corporate' x5 |
| contradicted | regimeShift | Invoice.amount | Invoice.amount keeps one scale over time (by Invoice.issued_on). | the median jumps x97.71 from 12800 (2020-04) to 131 (2020-07); no regime is declared |
| contradicted | requiredNulls | Order.order_date | Every Order has a value for Order.order_date. | 7 of 5000 row(s) (0.14%) have no value |
| unverified | unitMagnitude | Order.discount | Order.discount is in USD (x0.01). | no other field of the model in USD (x0.01) to compare with |
| unverified | unitMagnitude | Invoice.tax | Invoice.tax is in USD. | median \|value\| 0.12 is x1083 below the median of 3 other USD field(s) (130): possible scale mismatch |
| unverified | regimeShift | Order.discount | Order.discount keeps one scale over time (by Order.order_date). | fewer than two 3-month windows with at least 30 non-zero values |
| verified | primaryKey | Customer(customer_id) | customer_id identifies each Customer: never null, never repeated. | 1000 row(s), 1000 distinct key(s) |
| verified | primaryKey | Order(order_id) | order_id identifies each Order: never null, never repeated. | 5000 row(s), 5000 distinct key(s) |
| verified | primaryKey | Invoice(invoice_id, revision) | (invoice_id, revision) identifies each Invoice: never null, never repeated. | 5200 row(s), 5200 distinct key(s) |
| verified | cardinality | Order.placedBy | Each Order has at most one Customer through placedBy (many-to-one). | 4990 linked row(s), each reaching at most one Customer (observed many-to-one) |
| verified | orphans | Invoice.billedFor | Every Invoice.order_id that is set matches a row of Order (billedFor). | all 5200 foreign-key value(s) match a row of Order |
| verified | unitMagnitude | Customer.credit_limit | Customer.credit_limit is in USD. | median \|value\| 5000, within x41.67 of the median of 3 other USD field(s) (120) |
| verified | unitMagnitude | Order.total | Order.total is in USD. | median \|value\| 120, within x1.083 of the median of 3 other USD field(s) (130) |
| verified | unitMagnitude | Invoice.amount | Invoice.amount is in USD. | median \|value\| 130, within x1.083 of the median of 3 other USD field(s) (120) |
| verified | regimeShift | Customer.credit_limit | Customer.credit_limit keeps one scale over time (by Customer.signup_date). | 3 windows of 3 months; neighbouring medians stay within x1.041 |
| verified | regimeShift | Order.total | Order.total keeps one scale over time (by Order.order_date). | the median changes x100.8 from 12200 (2020-10) to 121 (2021-01), as the declared regime says: recorded in cents until 2020-12, in dollars since 2021-01. |
| verified | regimeShift | Order.quantity | Order.quantity keeps one scale over time (by Order.order_date). | 6 windows of 3 months; neighbouring medians stay within x1.333 |
| verified | regimeShift | Invoice.tax | Invoice.tax keeps one scale over time (by Invoice.issued_on). | 4 windows of 3 months; neighbouring medians stay within x1.083 |
| verified | requiredNulls | VipCustomer.email | Every VipCustomer has a value for VipCustomer.email. | all 120 row(s) have a value |
| verified | requiredNulls | Order.status | Every Order has a value for Order.status. | all 5000 row(s) have a value |

Not profiled:

- Supplier key supplier_id: entity 'Supplier' has no bound table under this binding
- relationship suppliedBy: relationship 'suppliedBy' has no join columns
- Order.shipping_cost unit: field 'Order.shipping_cost' is not bound under this binding
- constraint Order_shipping_cost_required: field 'Order.shipping_cost' is not bound under this binding
