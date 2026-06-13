# Inventory Management Glossary

This glossary is maintained by the Supply Chain Analytics team as a shared reference for terminology used across our planning, procurement, and warehouse processes. It is intended as an onboarding aid for new analysts and a tie-breaker when teams use terms inconsistently.

## Core terms

**SKU (Stock Keeping Unit).** A SKU is our internal identifier for a distinct, sellable product variant. "Variant" matters here: a single product line such as a t-shirt becomes many SKUs once you account for size and color, because each size/color/pack combination is tracked separately. The SKU is the unit at which we hold and count inventory in every distribution center. People sometimes casually call it the "item number," which is fine, but do not confuse the SKU with the **UPC** or **GTIN**. The UPC/GTIN is an *external* barcode standard assigned for retail scanning and is shared across the industry; the SKU is internal to us and never leaves our systems. A product can have one UPC but several of our SKUs over its life, so the two are not interchangeable.

**Lead time.** The elapsed time from the moment we place a purchase order with a supplier to the moment the goods are received, inspected, and available to pick. It is not just shipping time — it includes the supplier's own order processing and our inbound putaway. Lead time is rarely a constant; its variability is one of the main reasons we carry buffer inventory.

**Safety stock.** Extra inventory we deliberately hold on top of expected demand to absorb surprises — a demand spike, or a supplier shipment that runs late. Without safety stock, any variability in demand or lead time would translate directly into stockouts. We size safety stock either as a number of days of supply or against a target service level.

**Reorder point.** The inventory level at which the system automatically triggers a replenishment order. When on-hand stock for a SKU falls to its reorder point, a purchase order is generated. The reorder point is derived from demand, lead time, and safety stock — see the Inventory Policy Memo for the exact formula.

## A note on usage

When writing planning documents, prefer "reorder point" over the informal "reorder level"; both refer to the same thing but the former is what our ERP fields are labeled. Likewise, "buffer stock" and "safety stock" are synonyms.
