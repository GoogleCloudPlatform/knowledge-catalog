---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Review Task Result Types
description: Enumerated types for the outcomes of review tasks on Stack Exchange.
tags:
- review
- tasks
- results
- enum
- schema
- data dump
timestamp: '2026-05-28T23:35:05+00:00'
---

This document defines the enumerated types for the outcomes of various review tasks on Stack Exchange sites.

- `1`: Skip
- `2`: Approve (suggested edits)
- `3`: Reject (suggested edits)
- `4`: Delete (low quality)
- `5`: Edit (first posts, late answers, low quality)
- `6`: Close (close, low quality)
- `7`: Looks OK (low quality)
- `8`: Do Not Close (close)
- `9`: Recommend Deletion (low quality answer)
- `10`: Recommend Close (low quality question)
- `11`: Other Action (first posts), previously "I\'m Done"
- `12`: Reopen (reopen)
- `13`: Leave Closed (reopen)
- `14`: Edit and Reopen (reopen)
- `15`: Excellent (community evaluation)
- `16`: Satisfactory (community evaluation)
- `17`: Needs Improvement (community evaluation)
- `18`: No Action Needed (first posts, late answers)

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
