---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Review Tasks
description: Stores information about moderation review tasks on Stack Exchange, such
  as suggested edits or close votes.
tags:
- review
- tasks
- moderation
- schema
- data dump
timestamp: '2026-05-28T23:35:29+00:00'
---

This table stores information about moderation review tasks on Stack Exchange, such as suggested edits or close votes.

## Schema
- `Id` (INTEGER) - Unique identifier for the review task.
- `ReviewTaskTypeId` (INTEGER) - The type of review task. See the [Review Task Types reference](review_task_types.md) for possible values.
- `CreationDate` (TIMESTAMP) - The date when the review task was created. Time data is typically removed to protect user privacy.
- `DeletionDate` (TIMESTAMP) - The date when the review task was deleted. Time data is typically removed to protect user privacy. Nullable.
- `ReviewTaskStateId` (INTEGER) - The current state of the review task. See the [Review Task States reference](review_task_states.md) for possible values.
- `PostId` (INTEGER) - The ID of the post associated with the review task. Links to the `posts` tables (`posts_questions` or `posts_answers`). Nullable.
- `SuggestedEditId` (INTEGER) - The ID of the suggested edit associated with the review task, if applicable. Links to the `SuggestedEdits` table. Nullable.
- `CompletedByReviewTaskId` (INTEGER) - The ID associated with the `ReviewTaskResult` that stores the outcome of a completed review. Links to the [Review Task Results reference](review_task_results.md). Nullable.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
