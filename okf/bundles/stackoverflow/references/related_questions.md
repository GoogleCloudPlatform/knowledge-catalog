---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: Related Questions
description: Provides a mapping between questions and other related questions based
  on various factors.
tags:
- questions
- related
- schema
- data dump
timestamp: '2026-05-28T23:34:15+00:00'
---

This table provides a mapping between questions and other related questions, based on factors like content similarity or user behavior.

## Schema
- `PostId` (INTEGER) - The ID of the primary question. Links to the `posts_questions` table.
- `RelatedPostId` (INTEGER) - The ID of a related question. Links to the `posts_questions` table.
- `Position` (INTEGER) - The position or ranking of the related question.
- `Score` (INTEGER) - A score indicating the relevance or strength of the relationship.

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
