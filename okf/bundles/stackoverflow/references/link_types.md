---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Link Types
description: Enumerated types for links between posts on Stack Exchange.
tags:
- links
- enum
- schema
- data dump
timestamp: '2026-05-28T23:34:01+00:00'
---

This document defines the enumerated types for links between posts, as found in the `PostLinks` table.

- `1`: Linked (`PostId` contains a link to `RelatedPostId`)
- `3`: Duplicate (`PostId` is a duplicate of `RelatedPostId`)

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
