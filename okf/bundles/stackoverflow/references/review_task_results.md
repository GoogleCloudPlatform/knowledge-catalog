---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Review Task Results
description: Stores the outcomes and details of completed review tasks.
tags:
- review
- tasks
- results
- schema
- data dump
timestamp: '2026-05-28T23:35:11+00:00'
---

This table stores the outcomes and details of completed review tasks, such as approvals, rejections, or edits.

## Schema
- `Id` (INTEGER) - Unique identifier for the review task result.
- `ReviewTaskId` (INTEGER) - The ID of the review task this result is for. Links to the `ReviewTasks` table.
- `ReviewTaskResultTypeId` (INTEGER) - The type of result. See the [Review Task Result Types reference](review_task_result_types.md) for possible values.
- `CreationDate` (TIMESTAMP) - The date when the result was recorded. Time data is purposefully removed to protect user privacy.
- `RejectionReasonId` (INTEGER) - The ID of the rejection reason, specifically for suggested edits. Links to the [Review Rejection Reasons reference](review_rejection_reasons.md). Nullable.
- `Comment` (STRING) - A comment associated with the review result. Nullable.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
