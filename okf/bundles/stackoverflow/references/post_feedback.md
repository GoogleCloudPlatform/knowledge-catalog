---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Post Feedback
description: Collects up and down votes from anonymous visitors and unregistered users.
tags:
- feedback
- votes
- anonymous
- schema
- data dump
timestamp: '2026-05-28T23:33:30+00:00'
---

This table collects up and down votes from anonymous visitors and/or unregistered users.

## Schema
- `Id` (INTEGER) - Unique identifier for the post feedback entry.
- `PostId` (INTEGER) - The ID of the post (`posts_questions` or `posts_answers`) the feedback is for.
- `IsAnonymous` (BOOLEAN) - Indicates if the feedback was given anonymously.
- `VoteTypeId` (INTEGER) - The type of vote. Specifically `2` for UpMod and `3` for DownMod in this table. See the [Vote Types reference](vote_types.md) for a comprehensive list.
- `CreationDate` (TIMESTAMP) - The date and time the feedback was recorded.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
