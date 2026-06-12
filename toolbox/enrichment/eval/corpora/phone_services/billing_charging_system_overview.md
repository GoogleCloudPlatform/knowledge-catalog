# Billing & Charging System Overview

**Owner:** Billing Platform Engineering **Audience:** Engineers and analysts working with charging and invoicing

This overview explains how usage becomes a bill, in concept. No schema detail.

## Rating and the billing cycle

The system turns raw usage events into money in two conceptual stages: **rating** and **billing**.

- **Rating** applies the customer's price plan to each usage event to compute a charge.
- **Billing** accumulates rated charges over the customer's **billing cycle** — the recurring period over which usage is aggregated — and produces an invoice at the cycle close.

Each subscriber belongs to a billing cycle; cycle boundaries are staggered across the customer base so invoicing load is spread through the month rather than spiking on a single day.

## Prepaid vs postpaid

The billing cycle behaves differently by plan type:

- **Postpaid:** usage is rated and accumulated across the cycle, then invoiced at the end. The customer pays in arrears.
- **Prepaid:** charges are decremented from a balance in real time as usage occurs; the "cycle" is mainly a window for plan allowances rather than an invoice period.

## Where QoS comes in

Charging and **QoS (Quality of Service)** intersect for data plans. Some plans tie a data allowance to a QoS treatment — for example, full-speed data up to a threshold, after which the subscriber's traffic is moved to a lower-priority QoS class (commonly experienced as "throttling") rather than being cut off. The charging system signals the policy function when a threshold is crossed so the appropriate QoS class is applied for the remainder of the cycle.

## Reconciliation

At cycle close, rated charges are reconciled against the invoice total before issuance; discrepancies are held for review rather than billed.
