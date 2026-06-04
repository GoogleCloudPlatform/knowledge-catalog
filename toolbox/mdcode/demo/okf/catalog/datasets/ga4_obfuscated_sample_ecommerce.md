---
type: BigQuery Dataset
resource: https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/ga4_obfuscated_sample_ecommerce
title: BigQuery sample dataset for Google Analytics ecommerce web implementation
description: A sample of obfuscated Google Analytics BigQuery event export data for
  three months from the Google Merchandise Store is available as a public dataset
  in BigQuery.
tags:
- ecommerce
- web analytics
- Google Analytics
- BigQuery
- public dataset
timestamp: '2026-05-28T22:49:59+00:00'
---

# Overview
The `ga4_obfuscated_sample_ecommerce` dataset contains obfuscated Google Analytics BigQuery event export data for three months (November 2020 to January 2021) from the Google Merchandise Store. This public dataset is available in BigQuery and emulates a real-world dataset.

# Pre-requisites
To work with this dataset, you need access to a Google Cloud project with the BigQuery API enabled. You can use BigQuery Sandbox mode or the Free usage tier for exploration and sample queries.

# Limitations
The dataset contains obfuscated data with placeholder values like `<Other>`, `NULL`, and `''`. Due to obfuscation, the internal consistency of the dataset might be somewhat limited. It cannot be compared to the Google Analytics Demo Account.

# Using the dataset
You can access the `ga4_obfuscated_sample_ecommerce` dataset via the BigQuery UI in the Cloud Console.

## Sample Query
The following query shows the number of unique events, users, and days in the dataset:

```sql
SELECT
  COUNT(*) AS event_count,
  COUNT(DISTINCT user_pseudo_id) AS user_count,
  COUNT(DISTINCT event_date) AS day_count
FROM `bigquery-public-data.ga4_obfuscated_sample_ecommerce.events_*`
```

# Citations
- https://developers.google.com/analytics/bigquery/web-ecommerce-demo-dataset
