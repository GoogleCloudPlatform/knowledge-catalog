# NOAA GHCN-Daily sample

Runs the reference agent against the **NOAA Global Historical Climatology
Network Daily (GHCN-D)** dataset, distributed as Hive-partitioned Snappy
Parquet files in the AWS Open Data bucket `s3://noaa-ghcn-pds` (region
`us-east-1`, anonymously listable, free to access — storage is sponsored
by the AWS Open Data program).

There is no public Glue catalog to point at — AWS Open Data publishes
raw S3 buckets, not catalog entries, and a Glue Data Catalog cannot be
shared across accounts the way a BigQuery public dataset can. You
register the data as a table in your **own** Glue database first, then run
the agent against that database. Storage is free; you pay only for Athena
scan bytes per query (row-sampling in `enrich` runs a small `LIMIT` query
against a single partition, so cost is minimal).

## Bucket layout

```
s3://noaa-ghcn-pds/
  parquet/
    by_year/YEAR=<yyyy>/ELEMENT=<code>/<hash>_<n>.snappy.parquet
    by_station/...
  csv/
  csv.gz/
  ghcnd-stations.txt
  ghcnd-countries.txt
  ghcnd-states.txt
  ghcnd-inventory.txt
```

Years run from 1750 to present. `ELEMENT` is the observation type — common
codes include `TMAX`, `TMIN`, `PRCP`, `SNOW`, `ADPT`, `ASLP`, and many
others. Each object within a partition is a Snappy-compressed Parquet file.

**Parquet schema** (verified from `YEAR=2024/ELEMENT=TMAX`):

| Column | Type | Notes |
|--------|------|-------|
| `ID` | string | Station ID, e.g. `USC00518108` |
| `DATE` | string | `YYYYMMDD`, e.g. `20240101` |
| `DATA_VALUE` | int64 | For TMAX/TMIN, tenths of °C (272 = 27.2 °C) |
| `M_FLAG` | string | Measurement flag (often null) |
| `Q_FLAG` | string | Quality flag (often null) |
| `S_FLAG` | string | Source flag, e.g. `H` |
| `OBS_TIME` | string | Observation time, e.g. `2400` |

## Step 1: create a Glue database

```
aws glue create-database --database-input '{"Name":"noaa_ghcn"}'
```

## Step 2: register the observations table

Run this in Athena to create a Glue-backed external table:

```sql
CREATE EXTERNAL TABLE noaa_ghcn.daily_observations (
  id         string,
  date       string,
  data_value bigint,
  m_flag     string,
  q_flag     string,
  s_flag     string,
  obs_time   string
)
PARTITIONED BY (year string, element string)
STORED AS PARQUET
LOCATION 's3://noaa-ghcn-pds/parquet/by_year/'
```

## Step 3: add partitions

Do **not** run `MSCK REPAIR TABLE` here — with roughly 270 years and
hundreds of distinct element codes, it would enumerate tens of thousands
of partitions, making the repair scan extremely slow and expensive.
Add a handful of specific partitions instead:

```sql
ALTER TABLE noaa_ghcn.daily_observations
  ADD IF NOT EXISTS
  PARTITION (year='2024', element='TMAX')
    LOCATION 's3://noaa-ghcn-pds/parquet/by_year/YEAR=2024/ELEMENT=TMAX/'
  PARTITION (year='2024', element='TMIN')
    LOCATION 's3://noaa-ghcn-pds/parquet/by_year/YEAR=2024/ELEMENT=TMIN/'
  PARTITION (year='2024', element='PRCP')
    LOCATION 's3://noaa-ghcn-pds/parquet/by_year/YEAR=2024/ELEMENT=PRCP/'
  PARTITION (year='2024', element='SNOW')
    LOCATION 's3://noaa-ghcn-pds/parquet/by_year/YEAR=2024/ELEMENT=SNOW/';
```

Add more partitions (or other years) as needed.

**Unverified caveats** (could not be tested without running Athena against
the table):

- The Parquet files use uppercase column names (`ID`, `DATE`, etc.) while
  the Glue/Athena table DDL above uses lowercase. Athena's Parquet reader
  is normally case-insensitive by column name, but if a column reads back
  as all NULL, the mismatch is the cause — update the DDL to use uppercase
  names to resolve it.
- `MSCK REPAIR TABLE` may not recognise the uppercase `YEAR=` / `ELEMENT=`
  partition directory prefixes at all. The explicit `ADD PARTITION` form
  above sidesteps this regardless.

## Step 4: run the agent

```
.venv/bin/python -m aws_reference_agent enrich \
    --source glue \
    --database noaa_ghcn \
    --web-seed-file samples/noaa_ghcn/seeds.txt \
    --out ./bundles/noaa_ghcn
```

To iterate on a single concept, add `--concept tables/daily_observations`.
To skip Athena row sampling (and drop the need for `athena:*` and S3
permissions beyond the Glue read — see the IAM section in the top-level
README), add `--no-sample`. Add `--profile <name>` / `--region us-east-1`
if not using your default AWS credentials.

## What you get

A bundle under `./bundles/noaa_ghcn/` with one OKF doc per Glue concept
(database + `daily_observations` table), augmented and cross-linked with
reference docs minted from the seeded NOAA documentation pages, plus an
auto-generated `index.md` at each directory level.

**No bundle is committed for this sample yet.** Steps 1-3 have not been
run against a real Glue/Athena catalog, so there is nothing under
`bundles/noaa_ghcn/` to browse.
