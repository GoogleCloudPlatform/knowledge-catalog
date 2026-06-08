---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Suggested Edits
description: Stores information about suggested edits to posts that are awaiting review.
tags:
- suggested edits
- posts
- schema
- data dump
timestamp: '2026-05-28T23:35:39+00:00'
---

This table stores information about suggested edits to posts that are awaiting review. If both `ApprovalDate` and `RejectionDate` are null, then the edit is still in review.

## Schema
- `Id` (INTEGER) - Unique identifier for the suggested edit.
- `PostId` (INTEGER) - The ID of the post to which the suggested edit applies. Links to the `posts` tables (`posts_questions` or `posts_answers`).
- `CreationDate` (TIMESTAMP) - The date and time the suggested edit was created.
- `ApprovalDate` (TIMESTAMP) - The date and time the suggested edit was approved. Null if not yet approved.
- `RejectionDate` (TIMESTAMP) - The date and time the suggested edit was rejected. Null if not yet rejected.
- `OwnerUserId` (INTEGER) - The ID of the user who suggested the edit. Links to the `users` table.
- `Comment` (STRING) - A comment provided with the suggested edit. Nullable.
- `Text` (STRING) - The proposed new body text for the post. Nullable.
- `Title` (STRING) - The proposed new title for the post. Nullable.
- `Tags` (STRING) - The proposed new tags for the post. Nullable.
- `RevisionGUID` (STRING) - A GUID for the revision.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
