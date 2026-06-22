---
type: Reference
title: Revenue recognition policy source
description: A small example where attribution to the governing source must survive.
timestamp: '2026-06-18T00:00:00+00:00'
tags: [summary-policy, conformance]
summary_policy:
  required_assertions:
    - id: source_is_finance_policy
      text: "The revenue recognition rule is sourced from the Finance Policy Manual."
  forbidden_compressions:
    - id: unattributed_rule
      text: "Do not present the revenue recognition rule without its governing source."
---

# Policy note

The revenue recognition rule comes from the **Finance Policy Manual**, section
4.2. Customer setup fees are recognized over the expected service period unless
a separate performance obligation is documented.
