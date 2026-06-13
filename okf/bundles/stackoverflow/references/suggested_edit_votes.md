---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Suggested Edit Votes
description: Records votes cast on suggested edits, indicating approval or rejection.
tags:
- suggested edits
- votes
- schema
- data dump
timestamp: '2026-05-28T23:35:46+00:00'
---

This table records votes cast on suggested edits, indicating approval or rejection.

## Schema
- `Id` (INTEGER) - Unique identifier for the suggested edit vote.
- `SuggestedEditId` (INTEGER) - The ID of the suggested edit that was voted on. Links to the [Suggested Edits reference](suggested_edits.md).
- `UserId` (INTEGER) - The ID of the user who cast the vote. Links to the `users` table.
- `VoteTypeId` (INTEGER) - The type of vote. Specifically `2` for Approve (UpMod) and `3` for Reject (DownMod). See the [Vote Types reference](vote_types.md) for a comprehensive list.
- `CreationDate` (TIMESTAMP) - The date and time the vote was cast.
- `TargetUserId` (INTEGER) - The ID of the target user for the vote (e.g., the user whose reputation changed). Links to the `users` table. Nullable.
- `TargetRepChange` (INTEGER) - The change in reputation for the target user as a result of this vote. Nullable.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
