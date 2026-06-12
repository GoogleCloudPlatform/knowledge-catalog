---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Tag Synonyms
description: Stores relationships between synonymous tags on Stack Exchange.
tags:
- tags
- synonyms
- schema
- data dump
timestamp: '2026-05-28T23:35:52+00:00'
---

This table stores relationships between synonymous tags, allowing for automatic renaming or suggestion of alternative tags.

## Schema
- `Id` (INTEGER) - Unique identifier for the tag synonym.
- `SourceTagName` (STRING) - The name of the tag that is considered a synonym. Nullable. Links to the `tags` table\'s `tag_name` field.
- `TargetTagName` (STRING) - The name of the canonical tag to which `SourceTagName` refers. Nullable. Links to the `tags` table\'s `tag_name` field.
- `CreationDate` (TIMESTAMP) - The date and time the tag synonym was created.
- `OwnerUserId` (INTEGER) - The ID of the user who created the tag synonym. Nullable. Links to the `users` table.
- `AutoRenameCount` (INTEGER) - The number of times this synonym has resulted in an automatic tag rename.
- `LastAutoRename` (TIMESTAMP) - The date and time of the last automatic rename using this synonym. Nullable.
- `Score` (INTEGER) - A score indicating the quality or consensus of the synonym.
- `ApprovedByUserId` (INTEGER) - The ID of the user who approved the tag synonym. Nullable. Links to the `users` table.
- `ApprovalDate` (TIMESTAMP) - The date and time the tag synonym was approved. Nullable.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
