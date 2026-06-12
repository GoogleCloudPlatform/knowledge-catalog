---
type: Reference
resource: https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede
title: SEDE In Each DB Stored Procedure
description: Describes the SEDE internal stored procedure for running SQL commands
  across multiple databases.
tags:
- SEDE
- internal
- stored procedure
- SQL
- data dump
timestamp: '2026-05-28T23:36:39+00:00'
---

This is an internal stored procedure in the Stack Exchange Data Explorer (SEDE) used to execute SQL commands across multiple databases (i.e., Stack Exchange sites).

## Parameters
| Parameter           | Data Type      | Default | Description                                                               |
|---------------------|----------------|---------|---------------------------------------------------------------------------|
| `@SQLCommand`       | `nvarchar(4000)` |         | The SQL statement to run.                                                 |
| `@IncludeMainSites` | `bit`          | `1`     | Set to `1` to include all non-meta sites.                                 |
| `@IncludeMetaSites` | `bit`          | `1`     | Set to `1` to include all meta sites.                                     |
| `@IncludeMainMeta`  | `bit`          | `1`     | Set to `1` to include `StackExchange.Meta`.                               |
| `@CollectResultsForMe` | `bit`          | `1`     | For standard `SELECT` queries, this will attempt to put each database's results into a `#temp` table. |
| `@ErrorOnSkippedSites` | `bit`          | `0`     | Set this to `1` if you want execution to halt in the event any site is missing due to transition change. |

# Citations
- [Database schema documentation for the public data dump and SEDE](https://meta.stackexchange.com/questions/2677/database-schema-documentation-for-the-public-data-dump-and-sede)
