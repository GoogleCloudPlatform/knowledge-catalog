---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Close Reason Types
description: Enumerated types for reasons why a post might be closed on Stack Exchange.
tags:
- close reasons
- moderation
- enum
- schema
- data dump
timestamp: '2026-05-28T23:33:07+00:00'
---

This document defines the enumerated types for reasons why a post might be closed on Stack Exchange sites, as found in the `PendingFlags` and `PostHistory` tables.

## Old Close Reasons
- `1`: Exact Duplicate
- `2`: Off-topic
- `3`: Subjective and argumentative
- `4`: Not a real question
- `7`: Too localized
- `10`: General reference
- `20`: Noise or pointless (Meta sites only)

## Current Close Reasons
- `101`: Duplicate
- `102`: Off-topic
- `103`: Unclear what you\'re asking
- `104`: Too broad
- `105`: Primarily opinion-based

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
