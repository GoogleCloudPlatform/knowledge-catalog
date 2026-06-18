---
type: Reference
title: Trial exclusion result
description: A small example where a negated result must survive summarization.
timestamp: '2026-06-18T00:00:00+00:00'
tags: [summary-policy, conformance]
summary_policy:
  required_assertions:
    - id: no_evidence_of_harm
      text: "The review found no evidence that the treatment increased serious adverse events."
  forbidden_compressions:
    - id: harm_inversion
      text: "Do not summarize the finding as evidence that the treatment increased serious adverse events."
---

# Finding

The review found **no evidence** that the treatment increased serious adverse
events in the observed population. This is not the same as proving the treatment
reduces serious adverse events.
