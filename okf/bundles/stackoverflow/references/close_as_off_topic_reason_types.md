---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Close As Off-Topic Reason Types
description: Defines the types and guidance for reasons why a post might be closed
  as off-topic.
tags:
- close reasons
- off-topic
- enum
- schema
- data dump
timestamp: '2026-05-28T23:32:53+00:00'
---

This table defines the enumerated reasons and associated guidance for why a post might be closed as off-topic.

## Schema
- `Id` (INTEGER) - Unique identifier for the reason type.
- `IsUniversal` (BOOLEAN) - Indicates if the reason is universally applicable.
- `InputTitle` (STRING) - The title shown for input.
- `MarkdownInputGuidance` (STRING) - Markdown guidance shown while flagging/voting.
- `MarkdownPostOwnerGuidance` (STRING) - Markdown guidance shown to the original poster when closed.
- `MarkdownPublicGuidance` (STRING) - Markdown guidance shown to privileged users when closed.
- `MarkdownConcensusDescription` (STRING) - Markdown description shown above the public or post owner guidance. Nullable.
- `CreationDate` (TIMESTAMP) - The date and time the reason type was created.
- `CreationModeratorId` (INTEGER) - The ID of the moderator who created the reason type. Links to the `users` table.
- `ApprovalDate` (TIMESTAMP) - The date and time the reason type was approved.
- `ApprovalModeratorId` (INTEGER) - The ID of the moderator who approved the reason type.
- `DeactivationDate` (TIMESTAMP) - The date and time the reason type was deactivated.
- `DeactivationModeratorId` (INTEGER) - The ID of the moderator who deactivated the reason type. Links to the `users` table.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
