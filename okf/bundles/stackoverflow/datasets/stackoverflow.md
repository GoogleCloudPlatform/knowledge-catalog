---
type: BigQuery Dataset
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow
title: Stack Overflow Public Dataset
description: The Stack Overflow public dataset contains a variety of tables related
  to Stack Overflow user activity, posts, and tags. This dataset is no longer actively
  updated.
tags: Stack Overflow, public data, community, Q&A
timestamp: '2026-05-28T23:25:15+00:00'
---

The Stack Overflow public dataset in BigQuery provides a comprehensive collection of data from the popular question and answer platform. This dataset is a valuable resource for researchers and developers interested in analyzing trends in programming questions, user interactions, and the evolution of technology discussions. It encompasses various aspects of the platform, including user profiles, questions, answers, comments, votes, badges awarded, and associated tags.

This dataset was last updated on 2022-11-25, and it is important to note that it is no longer actively maintained. Despite this, it remains a rich historical archive of Stack Overflow activity. The dataset is hosted in the `US` multi-region.

# Schema

As a BigQuery Dataset, `stackoverflow` serves as a container for numerous tables rather than having a schema itself. The tables within this dataset collectively represent the structure of Stack Overflow data. Key tables include:

*   [badges](../tables/badges.md): Information about badges awarded to users.
*   [comments](../tables/comments.md): User comments on posts.
*   [post_history](../tables/post_history.md): Historical revisions and events for posts.
*   [posts_answers](../tables/posts_answers.md): Detailed information about answers.
*   [posts_questions](../tables/posts_questions.md): Detailed information about questions.
*   [tags](../tables/tags.md): Information about tags used to categorize posts.
*   [users](../tables/users.md): User profiles and statistics.
*   [votes](../tables/votes.md): Records of upvotes and downvotes on posts and comments.

# Common query patterns

List all tables within the `stackoverflow` dataset:

```sql
SELECT table_id
FROM `bigquery-public-data.stackoverflow.INFORMATION_SCHEMA.TABLES`
WHERE table_schema = 'stackoverflow';
```

Example of querying the `posts_questions` table:

```sql
SELECT
  id,
  title,
  view_count,
  creation_date
FROM
  `bigquery-public-data.stackoverflow.posts_questions`
WHERE
  creation_date BETWEEN '2021-01-01' AND '2021-01-31'
ORDER BY
  view_count DESC
LIMIT 5;
```

# Citations

[1] [Stack Overflow Public Dataset](https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/stackoverflow)
[2] [Stack Overflow Official Website](https://stackoverflow.com/)
