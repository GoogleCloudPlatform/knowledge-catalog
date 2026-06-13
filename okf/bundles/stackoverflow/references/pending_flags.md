---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Pending Flags
description: Stores information about pending flags and votes related to post moderation.
tags:
- flags
- moderation
- schema
- data dump
timestamp: '2026-05-28T23:33:15+00:00'
---

This table contains information about pending flags and votes related to post moderation, despite its name focusing on "PendingFlags". It includes close-related flags and votes.

## Schema
- `Id` (INTEGER) - Unique identifier for the pending flag.
- `FlagTypeId` (INTEGER) - The type of flag. See the [Flag Types reference](flag_types.md) for possible values:
    - `13`: canned flag for closure
    - `14`: vote to close
    - `15`: vote to reopen
- `PostId` (INTEGER) - The ID of the post the flag is associated with. Links to the `posts` tables (`posts_questions` or `posts_answers`).
- `CreationDate` (TIMESTAMP) - The date and time the flag was created.
- `CloseReasonTypeId` (INTEGER) - The type of close reason, if applicable. See the [Close Reason Types reference](close_reason_types.md) for possible values.
- `CloseAsOffTopicReasonTypeId` (INTEGER) - The specific off-topic reason ID, if `CloseReasonTypeId = 102` (off-topic). Links to the [Close As Off-Topic Reason Types reference](close_as_off_topic_reason_types.md).
- `DuplicateOfQuestionId` (INTEGER) - The ID of the duplicate question, if `CloseReasonTypeId` is `1` or `101` (old or current duplicate). Links to the `posts_questions` table.
- `BelongsOnBaseHostAddress` (STRING) - Indicates the base host address for votes to close and migrate.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
