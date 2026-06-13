---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Review Rejection Reasons
description: Defines canned rejection reasons for suggested edits.
tags:
- review
- rejection
- reasons
- suggested edits
- schema
- data dump
timestamp: '2026-05-28T23:34:58+00:00'
---

This table defines canned rejection reasons for suggested edits.

## Schema
- `Id` (INTEGER) - Unique identifier for the rejection reason.
- `Name` (STRING) - The name of the rejection reason.
- `Description` (STRING) - A detailed description of the rejection reason.
- `PostTypeId` (INTEGER) - The type of post the reason applies to (e.g., `5` for Wiki, `6` for Excerpt). Otherwise, it is null. Links to the [Post Type IDs reference](post_type_ids.md).

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
