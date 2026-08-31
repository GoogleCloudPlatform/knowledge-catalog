> [!NOTE]
> **Internal Review Preview**: This Markdown document is generated exclusively for internal review inside Jetski/agent artifacts. It mirrors the exact cell sequence and structure of `curated_data_products.ipynb`. Do NOT publish or distribute this file externally.

<a href="https://colab.research.google.com/github/GoogleCloudPlatform/knowledge-catalog/blob/main/cookbooks/curated_data_products.ipynb?utm_source=devrel&utm_medium=colab_badge&utm_campaign=knowledge_catalog_contracts" target="_parent"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/></a>

# Production-grade Knowledge Catalog data governance, data contracts, and AI grounding with Gemini

This tutorial demonstrates how to build an enterprise Data Mesh governance architecture on Google Cloud using Knowledge Catalog (Data Products and Aspects), BigQuery, and Gemini.

---

## Executive overview

In modern decentralized data architectures (Data Mesh), data domain teams must publish certified data products backed by explicit **Data Contracts**. These contracts specify freshness service level agreements (SLAs), schema stability tiers, and verified business queries.

Downstream consumers—both human data analysts and autonomous AI agents—need a reliable, unified mechanism to discover these assets, verify contract compliance, and generate grounded, syntactically verified analytical queries without hallucination.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 ENTERPRISE DATA GOVERNANCE ARCHITECTURE                                │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  [PRODUCER DOMAIN]                                                                                     │
│  ┌───────────────────────┐         ┌────────────────────────────────────────────────────────────────┐  │
│  │ Cloud Storage         │ ──────▶ │ BigQuery Production Dataset (churn_prod)                       │  │
│  │ (Parquet Staging)     │         │  • customer_churn_summary (Live ingestion timestamp)           │  │
│  │                       │         │  • high_risk_churn_cohort (Certified analytical view)          │  │
│  │                       │         │  • stale_churn_archive    (38h delay simulation)               │  │
│  └───────────────────────┘         └────────────────────────────────────────────────────────────────┘  │
│                                                                   │                                    │
│                                                                   ▼                                    │
│  [GOVERNANCE & CATALOG LAYER]                                                                          │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Google Cloud Knowledge Catalog                                                                   │  │
│  │  • Data Product : customer-churn-analytics                                                       │  │
│  │  • Data Assets  : Bundled BigQuery table & certified view                                        │  │
│  │  • Aspect Type  : data-contract-spec (Cron cadence, Freshness SLA, Golden Query)                 │  │
│  │  • Catalog Entry: Scoped Aspect binding via aspect_keys                                          │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                     │                                              │                   │
│                                     ▼                                              ▼                   │
│  [CONSUMER: HUMAN ANALYST]                                     [CONSUMER: AI DATA AGENT]               │
│  ┌───────────────────────────────────────────────┐             ┌────────────────────────────────────┐  │
│  │ In-Table Timestamp SLA Scorecard Audit        │             │ Knowledge Catalog Discovery        │  │
│  │  • Active table : PASSED (Fresh)              │             │  • Reads live Aspect metadata      │  │
│  │  • Stale table  : FAILED (Breach detected)    │             │  • Zero in-memory mocking          │  │
│  └───────────────────────────────────────────────┘             └────────────────────────────────────┘  │
│                                                                                  │                     │
│                                                                                  ▼                     │
│                                                                ┌────────────────────────────────────┐  │
│                                                                │ Gemini Query Generation            │  │
│                                                                │  • Structured Pydantic Output      │  │
│                                                                │  • Certified View Prioritization   │  │
│                                                                └────────────────────────────────────┘  │
│                                                                                  │                     │
│                                                                                  ▼                     │
│                                                                ┌────────────────────────────────────┐  │
│                                                                │ BigQuery Dry-Run Safety Guardrail  │  │
│                                                                │  • Syntax & byte scan cost check   │  │
│                                                                │  • Certified SQL execution         │  │
│                                                                └────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Target persona
* **Data platform engineers and architects**: Designing decentralized governance, cataloging, and Data Contract enforcement.
* **Applied AI and data engineers**: Building enterprise Text-to-SQL or AI data agents grounded in enterprise catalog metadata.

### Prerequisites
* A Google Cloud project with billing enabled.
* Required permissions: Knowledge Catalog Admin, BigQuery Admin, Storage Admin, and access to Gemini models.
* Python 3.10+ in a Jupyter or Google Cloud Colab environment.

### Estimated time
* **25 minutes**

### Learning objectives
By following this tutorial, you will:
1. **Provision and manage** Knowledge Catalog Data Products and Data Assets programmatically using the official Google Cloud SDK.
2. **Define and attach** custom Aspect Types to enforce Data Contracts (freshness SLAs, stability tiers, and golden queries) in Knowledge Catalog.
3. **Audit and score** data freshness SLAs using deterministic in-table timestamps across compliant and stale scenarios.
4. **Ground and generate** Gemini analytical SQL queries using live Knowledge Catalog metadata.
5. **Implement and verify** BigQuery dry-run safety guardrails before executing generated queries.

---

## Environment setup and SDK initialization

In this section, you install the required Python libraries and initialize the official Google Cloud SDK clients.

To adhere to the principle of strict domain decoupling:
* Storage and analytical compute resources are provisioned in `us-central1`.
* Gemini models are accessed via the `global` AI endpoint.

```python
# Install dependencies and import libraries
%pip install -q google-cloud-dataplex google-cloud-bigquery google-cloud-storage google-genai pydantic tabulate db-dtypes

import datetime
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional
import uuid

if "google.colab" in sys.modules:
    from google.colab import auth
    auth.authenticate_user()
    print("Colab user session authenticated successfully.")

from google.api_core.exceptions import AlreadyExists, NotFound, PermissionDenied
from google.cloud import bigquery
from google.cloud import dataplex_v1
from google.cloud import storage
from google import genai
from google.genai import types
from pydantic import BaseModel, Field, ValidationError
from tabulate import tabulate
```

### Configure project parameters

Enter your Google Cloud project ID in the interactive parameter in the form. All governance identifiers, dataset names, and locations remain deterministic constants.

To adhere to the principle of strict domain decoupling:
* BigQuery dataset storage and Knowledge Catalog governance resources are provisioned in `REGION = "us-central1"`.
* Gemini models are accessed via the `global` AI endpoint (`GEMINI_LOCATION = "global"`).

> [!NOTE]
> **Data Residency & Endpoint Decoupling**: Gemini models use `GEMINI_LOCATION = "global"` because modern flagship models (`gemini-3.7-flash`) are deployed on global endpoints. Analytical compute and catalog governance resources are provisioned regionally in `REGION = "us-central1"`. If your enterprise compliance, sovereignty regulations, or VPC Service Controls require data processing within a specific region, verify regional model availability in Google Cloud documentation and configure `GEMINI_LOCATION` to your compliant region (such as `"us-central1"`). Customer prompt data processed by Gemini Enterprise is never used to train foundation models.

```python
# Configure project parameters and governance constants
PROJECT_ID = "your-project-id"  # @param {type:"string"}

if not PROJECT_ID or PROJECT_ID == "your-project-id":
    raise ValueError(
        "Missing required PROJECT_ID: Enter a valid Google Cloud project ID in the @param field before running."
    )

REGION = "us-central1"
MODEL_NAME = "gemini-3.7-flash"
GEMINI_LOCATION = "global"
DATA_PRODUCT_ID = "customer-churn-analytics"
DATASET_ID = "churn_prod"
ASPECT_TYPE_ID = "data-contract-spec"
OWNER_EMAIL = "analytics-lead@example.com"
BUCKET_NAME = f"{PROJECT_ID}-catalog-stage-{uuid.uuid4().hex[:6]}"

print("Configuration parameters validated successfully:")
print(f"  • Project ID         : {PROJECT_ID}")
print(f"  • Resource Region    : {REGION}")
print(f"  • Gemini Location    : {GEMINI_LOCATION}")
print(f"  • Data Product ID    : {DATA_PRODUCT_ID}")
print(f"  • BigQuery Dataset   : {DATASET_ID}")
print(f"  • Aspect Type ID     : {ASPECT_TYPE_ID}")
print(f"  • Staging Bucket     : gs://{BUCKET_NAME}")
```

### Initialize Google Cloud SDK clients

Initialize the native SDK clients for Cloud Storage, BigQuery, Knowledge Catalog, and the Google Gen AI SDK.

```python
# Initialize Google Cloud SDK clients
storage_client = storage.Client(project=PROJECT_ID)
bq_client = bigquery.Client(project=PROJECT_ID, location=REGION)
bq_client_us = bigquery.Client(project=PROJECT_ID, location="US")

catalog_client = dataplex_v1.CatalogServiceClient()
data_product_client = dataplex_v1.DataProductServiceClient()

gemini_client = genai.Client(vertexai=True, project=PROJECT_ID, location=GEMINI_LOCATION)

print("Google Cloud SDK clients initialized successfully.")
```

---

## Define data contract and response schemas

Data Contracts codify the operational and structural expectations between data producers and consumers. You use Pydantic models to define:
* **`DataContractSla`**: Freshness cadence, delivery time, max age threshold, and schema stability tier.
* **`GoldenQuery`**: Pre-certified SQL templates mapped to specific business glossary terms.
* **`GroundedQueryResponse`**: The structured output schema for Gemini query generation.

```python
# Define data contract and Pydantic response models
class DataContractSla(BaseModel):
    """Specification for data product freshness, cadence, and schema stability."""
    refresh_cadence_cron: str = Field(description="Asset refresh schedule in Cron format")
    expected_delivery_time_utc: str = Field(description="Expected delivery time in UTC")
    freshness_threshold_hours: int = Field(description="Maximum allowed data age in hours")
    schema_stability_tier: str = Field(description="Schema stability tier (e.g. STABLE_BACKWARDS_COMPATIBLE)")


class GoldenQuery(BaseModel):
    """Verified SQL query template mapped to a business metric."""
    query_title: str = Field(description="Human-readable title of the verified query")
    verified_sql: str = Field(description="Verified SQL template")
    glossary_term: str = Field(description="Business glossary metric mapped to this query")


class GroundedQueryResponse(BaseModel):
    """Structured response schema for Gemini query generation."""
    data_product_id: str = Field(description="Data Product ID referenced for query generation")
    target_asset_name: str = Field(description="Selected Knowledge Catalog Data Asset identifier")
    target_asset_table: str = Field(description="Target canonical BigQuery table or view name")
    glossary_terms_applied: List[str] = Field(description="List of applied business glossary terms")
    contract_sla_satisfied: bool = Field(description="Whether the freshness SLA is satisfied")
    sql_query: str = Field(description="Generated executable BigQuery SQL query")
    reasoning_summary: str = Field(description="Reasoning summary addressing the user prompt")


print("Governance data structures and Pydantic response models defined successfully.")
```

---

## Producer workflow: Ingest data and provision physical assets

To enable objective SLA auditing, the data producer attaches an explicit business ingestion timestamp (`ingestion_timestamp`) to each table.

In this step, you:
* Export certified credit card churn data from `bigquery-public-data` to Cloud Storage.
* Load the data into the production dataset `churn_prod` in `us-central1`.
* Provision a certified analytical view (`high_risk_churn_cohort`) that pre-filters churned high-limit customers.
* Provision a simulated stale table (`stale_churn_archive`) with timestamps set 38 hours in the past to test SLA breach detection.

```python
# Ingest data, append ingestion timestamps, and provision physical assets
staging_bucket = storage_client.create_bucket(BUCKET_NAME, location="US")
print(f"Cloud Storage staging bucket created: gs://{BUCKET_NAME} (Location: US)")

export_sql = f"""
EXPORT DATA OPTIONS(
    uri='gs://{BUCKET_NAME}/data/credit_card_*.parquet',
    format='PARQUET',
    overwrite=true
) AS
SELECT
    CAST(id AS INT64) AS customer_id,
    limit_balance,
    CAST(sex AS STRING) AS sex_code,
    CAST(education_level AS STRING) AS education_level,
    CAST(age AS INT64) AS age,
    CAST(default_payment_next_month AS INT64) AS is_churned
FROM `bigquery-public-data.ml_datasets.credit_card_default`
ORDER BY id ASC
LIMIT 1000;
"""
bq_client_us.query(export_sql).result()
print(f"Exported certified public dataset to gs://{BUCKET_NAME}/data/*.parquet")

dataset_ref = bigquery.DatasetReference(PROJECT_ID, DATASET_ID)
dataset = bigquery.Dataset(dataset_ref)
dataset.location = REGION
dataset = bq_client.create_dataset(dataset, exists_ok=True)
print(f"BigQuery dataset verified: {PROJECT_ID}.{DATASET_ID} (Location: {REGION})")

temp_stage_ref = dataset_ref.table("temp_staging_churn")
job_config = bigquery.LoadJobConfig(
    source_format=bigquery.SourceFormat.PARQUET,
    write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
)
load_job = bq_client.load_table_from_uri(f"gs://{BUCKET_NAME}/data/*.parquet", temp_stage_ref, job_config=job_config)
load_job.result()

create_prod_table_ddl = f"""
CREATE OR REPLACE TABLE `{PROJECT_ID}.{DATASET_ID}.customer_churn_summary` AS
SELECT
    *,
    CURRENT_TIMESTAMP() AS ingestion_timestamp
FROM `{PROJECT_ID}.{DATASET_ID}.temp_staging_churn`;
"""
bq_client.query(create_prod_table_ddl).result()
try:
    bq_client.delete_table(temp_stage_ref, not_found_ok=True)
except Exception as e:
    print(f"Notice on staging table deletion: {e}")
print(f"Provisioned production table with live ingestion timestamp: `{PROJECT_ID}.{DATASET_ID}.customer_churn_summary`")

create_view_ddl = f"""
CREATE OR REPLACE VIEW `{PROJECT_ID}.{DATASET_ID}.high_risk_churn_cohort` AS
SELECT
    customer_id,
    limit_balance,
    education_level,
    age,
    is_churned,
    ingestion_timestamp
FROM `{PROJECT_ID}.{DATASET_ID}.customer_churn_summary`
WHERE is_churned = 1 AND limit_balance > 50000;
"""
bq_client.query(create_view_ddl).result()
print(f"Created analytical view: `{PROJECT_ID}.{DATASET_ID}.high_risk_churn_cohort`")

create_stale_table_ddl = f"""
CREATE OR REPLACE TABLE `{PROJECT_ID}.{DATASET_ID}.stale_churn_archive` AS
SELECT
    customer_id,
    limit_balance,
    sex_code,
    education_level,
    age,
    is_churned,
    TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 38 HOUR) AS ingestion_timestamp
FROM `{PROJECT_ID}.{DATASET_ID}.customer_churn_summary`
LIMIT 100;
"""
bq_client.query(create_stale_table_ddl).result()
print(f"Created stale simulation table: `{PROJECT_ID}.{DATASET_ID}.stale_churn_archive` (Data Age: -38h)")
```

---

## Producer workflow: Knowledge Catalog data products and data assets

In a Data Mesh architecture, **Data Products** and **Data Assets** are fundamental, domain-driven governance building blocks implemented natively in Knowledge Catalog on Google Cloud.

### Key concepts and architectural roles

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               KNOWLEDGE CATALOG DATA PRODUCT CONTAINER                          │
│                                                                                                 │
│  • Resource Name : projects/{PROJECT_ID}/locations/{LOCATION}/dataProducts/{DATA_PRODUCT_ID}    │
│  • Domain Identity: domain="customer_analytics", tier="certified", owner="analytics-lead@..."   │
│  • Public Interface: Certified domain boundary delivering analytical value (Customer Churn)     │
│                                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ BUNDLED DATA ASSETS (Physical Cloud Resource Bindings)                                    │  │
│  │                                                                                           │  │
│  │  1. Data Asset: customer-churn-summary-table                                              │  │
│  │     └── Resource URI: //bigquery.googleapis.com/.../tables/customer_churn_summary         │  │
│  │     └── Role: Raw production analytical storage containing in-table ingestion timestamps  │  │
│  │                                                                                           │  │
│  │  2. Data Asset: high-risk-churn-cohort-view                                               │  │
│  │     └── Resource URI: //bigquery.googleapis.com/.../tables/high_risk_churn_cohort         │  │
│  │     └── Role: Certified analytical view with pre-filtered high-risk churn logic           │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Knowledge Catalog Data Product (Domain Container)**:
   * **Domain Boundary & Business Accountability**: Owned and maintained directly by a business domain team (e.g., Customer Analytics), certifying data reliability through explicit ownership (`owner_emails`), quality tiering (`tier: certified`), and confidentiality labels (`confidentiality: internal`).
   * **Consumer Public Interface**: Serves as the authoritative discovery entry point for downstream human analysts and AI agents, shielding consumers from underlying table partitioning, physical clustering, or raw storage paths.

2. **Knowledge Catalog Data Asset (Child Resource Binding)**:
   * **Logical-Physical Decoupling**: Maps physical cloud storage and analytical entities (BigQuery tables, views, Cloud Storage buckets) to uniform resource identifiers (`//bigquery.googleapis.com/...`) under the Data Product umbrella.
   * **Asset Role Specialization**: Bundling both base tables (`customer_churn_summary`) and certified analytical views (`high_risk_churn_cohort`) enables AI agents and consumers to dynamically choose the optimal query target (pre-filtered metric views vs. raw dimensional tables).

### Create the data product container

Create the `customer-churn-analytics` Data Product with domain labels and ownership metadata.

```python
# Create Knowledge Catalog Data Product container
parent_location = f"projects/{PROJECT_ID}/locations/{REGION}"
data_product_name = f"{parent_location}/dataProducts/{DATA_PRODUCT_ID}"

data_product_spec = dataplex_v1.DataProduct(
    display_name="Customer Churn Analytics Product",
    description="Certified analytical data product providing churn predictions, contract SLAs, and certified views.",
    owner_emails=[OWNER_EMAIL],
    labels={
        "domain": "customer_analytics",
        "tier": "certified",
        "confidentiality": "internal",
    },
)

op = data_product_client.create_data_product(
    parent=parent_location,
    data_product_id=DATA_PRODUCT_ID,
    data_product=data_product_spec,
)
data_product = op.result() if hasattr(op, "result") else op
print(f"Successfully created Data Product [{DATA_PRODUCT_ID}]")

print(f"  • Resource Name : {data_product.name}")
print(f"  • Display Name  : {data_product.display_name}")
print(f"  • Owners        : {list(data_product.owner_emails)}")
```

### Register BigQuery assets as data assets

Register both the production summary table and the analytical view as child `DataAsset` resources under the Data Product.

```python
# Register BigQuery physical assets as Data Asset sub-resources
assets_to_bundle = [
    {
        "id": "customer-churn-summary-table",
        "resource": f"//bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{DATASET_ID}/tables/customer_churn_summary",
    },
    {
        "id": "high-risk-churn-cohort-view",
        "resource": f"//bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{DATASET_ID}/tables/high_risk_churn_cohort",
    },
]

registered_assets = []
for asset in assets_to_bundle:
    asset_name = f"{data_product_name}/dataAssets/{asset['id']}"
    asset_spec = dataplex_v1.DataAsset(resource=asset["resource"])
    op = data_product_client.create_data_asset(
        parent=data_product_name,
        data_asset_id=asset["id"],
        data_asset=asset_spec,
    )
    asset_obj = op.result() if hasattr(op, "result") else op
    registered_assets.append(asset_obj)
    print(f"Registered Data Asset: [{asset['id']}] -> {asset['resource']}")

print(f"\nSuccessfully verified {len(registered_assets)} data assets inside Data Product [{DATA_PRODUCT_ID}].")
```

---

## Producer workflow: Knowledge Catalog aspect types and data contract binding

Google Cloud Knowledge Catalog utilizes an object-oriented, 3-tier metadata architecture comprising **Entries**, **Aspect Types**, and **Aspects** to codify rich operational and governance contracts beyond basic schema definitions.

### Knowledge Catalog 3-tier metadata architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               KNOWLEDGE CATALOG METADATA ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                 │
│  1. Aspect Type (data-contract-spec) [Schema Template / Class Definition]                       │
│     ├── refresh_cadence_cron      : string (Cron refresh schedule expression)                   │
│     ├── freshness_threshold_hours : int    (Max allowed data age SLA: 24h)                      │
│     ├── schema_stability_tier     : string (Stability guarantee: STABLE_BACKWARDS_COMPATIBLE)   │
│     └── golden_query_sql          : string (Pre-certified golden SQL query)                     │
│                                                                                                 │
│                                    │ Instantiation & Scoped Binding                             │
│                                    ▼                                                            │
│                                                                                                 │
│  2. Catalog Entry (projects/.../entryGroups/@bigquery/entries/.../customer_churn_summary)       │
│     ├── [System-Managed Aspects] BigQuery Schema, Partitioning, Table Size, Creation Time...    │
│     └── [Custom Governance Aspect: data-contract-spec]                                          │
│           ├── refresh_cadence_cron      = "0 6 * * *"                                           │
│           ├── freshness_threshold_hours = 24                                                    │
│           ├── schema_stability_tier     = "STABLE_BACKWARDS_COMPATIBLE"                         │
│           └── golden_query_sql          = "SELECT customer_id, limit_balance... FROM ..."       │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Catalog Entry**:
   * The fundamental unit representing a Google Cloud data resource (BigQuery table/view, Cloud Storage bucket, Pub/Sub topic) within Knowledge Catalog.
   * BigQuery tables are automatically discovered and indexed into system entry groups (`entryGroups/@bigquery/entries/...`).

2. **Aspect Type (Reusable Schema Template)**:
   * A strongly typed metadata class definition supporting primitive fields (string, int, bool, timestamp) and complex nested records.
   * In this tutorial, `data-contract-spec` acts as the formal contract template declaring SLA thresholds, update schedules, and certified SQL queries.

3. **Aspect (Instantiated Metadata Payload)**:
   * A concrete metadata instance populated with specific business values and attached to a target Entry.
   * An Entry can host multiple orthogonal Aspects (e.g., Data Contracts, Security Classification, Data Quality Scores) alongside system schema aspects.
   * Custom aspects are namespaced via `{project_id}.{location}.{aspect_type_id}`.

4. **Rationale for Scoped Updates via `aspect_keys`**:
   * Catalog Entries continuously maintain system-managed column schemas and table metadata.
   * When calling `catalog_client.update_entry`, specifying `aspect_keys=[aspect_key]` and `update_mask={"paths": ["aspects"]}` ensures that **only the target custom contract Aspect is modified atomically**, completely preventing accidental overwriting or conflict with system-managed metadata.

### Register the custom aspect type

Define and register the `data-contract-spec` Aspect Type containing contract attributes.

```python
# Create Knowledge Catalog Aspect Type and define governance contract
aspect_type_name = f"{parent_location}/aspectTypes/{ASPECT_TYPE_ID}"

aspect_type_spec = dataplex_v1.AspectType(
    display_name="Data Contract and Governance SLA",
    description="Standard schema for codifying SLAs, stability tiers, and certified queries.",
    labels={"governance": "contracts"},
    metadata_template=dataplex_v1.AspectType.MetadataTemplate(
        name="data_contract",
        type="record",
        record_fields=[
            dataplex_v1.AspectType.MetadataTemplate(name="refresh_cadence_cron", type="string", index=1),
            dataplex_v1.AspectType.MetadataTemplate(name="freshness_threshold_hours", type="int", index=2),
            dataplex_v1.AspectType.MetadataTemplate(name="schema_stability_tier", type="string", index=3),
            dataplex_v1.AspectType.MetadataTemplate(name="golden_query_sql", type="string", index=4),
        ],
    ),
)

op = catalog_client.create_aspect_type(
    parent=parent_location,
    aspect_type_id=ASPECT_TYPE_ID,
    aspect_type=aspect_type_spec,
)
aspect_type_res = op.result() if hasattr(op, "result") else op
print(f"Successfully registered AspectType [{ASPECT_TYPE_ID}]")

contract_sla = DataContractSla(
    refresh_cadence_cron="0 6 * * *",
    expected_delivery_time_utc="08:00 UTC",
    freshness_threshold_hours=24,
    schema_stability_tier="STABLE_BACKWARDS_COMPATIBLE",
)

golden_query = GoldenQuery(
    query_title="Top High Risk Churned Customers",
    verified_sql=(
        f"SELECT customer_id, limit_balance, education_level, age "
        f"FROM `{PROJECT_ID}.{DATASET_ID}.high_risk_churn_cohort` "
        f"ORDER BY limit_balance DESC LIMIT 5"
    ),
    glossary_term="High Risk Churn Rate",
)

print(f"✓ Aspect Type [{ASPECT_TYPE_ID}] and Governance Contract defined successfully.")
```

### Check indexing and attach the aspect

> [!NOTE]
> When BigQuery creates a table, Knowledge Catalog automatically discovers and indexes the canonical entry (`projects/.../entryGroups/@bigquery/entries/...`) in the background. This typically takes 30 to 60 seconds.
>
> To avoid overwriting system-managed schema aspects, the `update_entry` call scopes the operation specifically to the custom aspect using `aspect_keys=[aspect_key]`.

If the entry is still indexing when you run this cell, wait 10 to 15 seconds and re-run this cell.

```python
# Verify Knowledge Catalog Entry indexing and bind Aspect
canonical_entry_name = (
    f"projects/{PROJECT_ID}/locations/{REGION}/entryGroups/@bigquery/entries/"
    f"bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{DATASET_ID}/tables/customer_churn_summary"
)
aspect_key = f"{PROJECT_ID}.{REGION}.{ASPECT_TYPE_ID}"

catalog_entry = None
print("Waiting for Knowledge Catalog Entry indexing and binding Aspect...")
for attempt in range(24):  # Up to 120 seconds total wait
    try:
        catalog_entry = catalog_client.get_entry(name=canonical_entry_name)
        if catalog_entry:
            print(f"\n  ✓ Found catalog entry on attempt {attempt + 1}.")
            break
    except (NotFound, PermissionDenied):
        print(".", end="", flush=True)
    time.sleep(5)

if not catalog_entry:
    raise RuntimeError(
        f"Timed out waiting for BigQuery table to be indexed in Knowledge Catalog: {canonical_entry_name}"
    )

entry_patch = dataplex_v1.Entry(
    name=canonical_entry_name,
    aspects={
        aspect_key: dataplex_v1.Aspect(
            aspect_type=aspect_type_name,
            data={
                "refresh_cadence_cron": contract_sla.refresh_cadence_cron,
                "freshness_threshold_hours": contract_sla.freshness_threshold_hours,
                "schema_stability_tier": contract_sla.schema_stability_tier,
                "golden_query_sql": golden_query.verified_sql,
            },
        )
    },
)

update_request = dataplex_v1.UpdateEntryRequest(
    entry=entry_patch,
    update_mask={"paths": ["aspects"]},
    aspect_keys=[aspect_key],
)
updated_entry = catalog_client.update_entry(request=update_request)

print("================================================================================")
print(f"✓ [READY] Knowledge Catalog Entry is indexed: `{canonical_entry_name}`")
print(f"✓ [ATTACH] Successfully bound Aspect [{ASPECT_TYPE_ID}] to Entry!")
print("================================================================================")
```

---

## Consumer workflow: Human analyst SLA scorecard audit

Before consuming analytical assets, a data consumer audits the asset's actual freshness against the contracted SLA threshold (24 hours).

You execute a deterministic SQL query evaluating `MAX(ingestion_timestamp)` across:
* **Active Production Table**: Freshly ingested (Data Age $\approx 0.0$ hours) $\rightarrow$ **COMPLIANT (PASSED)**.
* **Stale Simulation Table**: Backdated 38 hours $\rightarrow$ **BREACHED (FAILED)**.

```python
# Audit freshness SLA via in-table timestamps against live Knowledge Catalog Aspect
print("Fetching live Data Contract Aspect from Knowledge Catalog...")
consumer_entry = catalog_client.get_entry(
    request=dataplex_v1.GetEntryRequest(
        name=canonical_entry_name,
        view=dataplex_v1.EntryView.ALL,
    )
)

# Extract SLA threshold dynamically from the catalog aspect (zero local memory reliance)
live_sla_aspect = consumer_entry.aspects.get(aspect_key)
if not live_sla_aspect or not live_sla_aspect.data:
    matched_key = next((k for k in consumer_entry.aspects if k.endswith(ASPECT_TYPE_ID)), None)
    if matched_key:
        live_sla_aspect = consumer_entry.aspects[matched_key]

if not live_sla_aspect or not live_sla_aspect.data:
    raise RuntimeError(f"Contract Aspect matching [{ASPECT_TYPE_ID}] not found on live entry `{canonical_entry_name}`.")

contract_freshness_threshold = int(live_sla_aspect.data.get("freshness_threshold_hours", 24))
contract_cadence = str(live_sla_aspect.data.get("refresh_cadence_cron", "0 6 * * *"))
contract_stability = str(live_sla_aspect.data.get("schema_stability_tier", "STABLE_BACKWARDS_COMPATIBLE"))

def evaluate_asset_freshness(table_name: str) -> float:
    """Query maximum in-table business timestamp to evaluate asset age in hours."""
    query = f"""
    SELECT ROUND(IEEE_DIVIDE(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(ingestion_timestamp), SECOND), 3600.0), 2) AS age_hours
    FROM `{PROJECT_ID}.{DATASET_ID}.{table_name}`
    """
    results = list(bq_client.query(query).result())
    return float(results[0].age_hours) if results else 9999.0

active_age_hours = evaluate_asset_freshness("customer_churn_summary")
active_sla_passed = active_age_hours <= contract_freshness_threshold

stale_age_hours = evaluate_asset_freshness("stale_churn_archive")
stale_sla_passed = stale_age_hours <= contract_freshness_threshold

scorecard_rows = [
    ["Target Asset", f"{PROJECT_ID}.{DATASET_ID}.customer_churn_summary", f"{PROJECT_ID}.{DATASET_ID}.stale_churn_archive"],
    ["Contract Source", f"Knowledge Catalog Aspect [{ASPECT_TYPE_ID}]", f"Knowledge Catalog Aspect [{ASPECT_TYPE_ID}]"],
    ["Contract Cadence", f"{contract_cadence} (Daily)", f"{contract_cadence} (Daily)"],
    ["Max Allowed Age", f"<= {contract_freshness_threshold} Hours", f"<= {contract_freshness_threshold} Hours"],
    ["Observed Data Age", f"{active_age_hours} Hours", f"{stale_age_hours} Hours"],
    ["Freshness Margin", f"{round(contract_freshness_threshold - active_age_hours, 2)} Hours", f"{round(contract_freshness_threshold - stale_age_hours, 2)} Hours"],
    ["Stability Tier", contract_stability, contract_stability],
    ["SLA Verification", "✓ COMPLIANT (PASSED)" if active_sla_passed else "✗ BREACHED", "✗ BREACHED (FAILED)" if not stale_sla_passed else "✓ COMPLIANT"],
]

print("=========================================================================================================")
print("             HUMAN ANALYST CONSUMER SCORECARD: AUDITING LIVE KNOWLEDGE CATALOG CONTRACTS                  ")
print("=========================================================================================================")
print(tabulate(scorecard_rows, headers=["Dimension", "Active Production Asset", "Stale Simulation Asset"], tablefmt="grid"))
```

---

## Consumer workflow: Grounded AI query generation with Gemini

In an enterprise AI workflow, the AI agent must not rely on local memory or hardcoded prompts. Instead, it dynamically queries the live Knowledge Catalog.

The grounding context provided to Gemini is constructed 100% from live Google Cloud metadata:
* Discovered Data Assets (distinguishing base tables from certified analytical views).
* The live Data Contract SLA and verified Golden Query template.

```python
# Discover catalog metadata and generate grounded query with Gemini
live_product = data_product_client.get_data_product(name=data_product_name)
discovered_raw_assets = list(data_product_client.list_data_assets(parent=data_product_name))


def parse_bigquery_resource_uri(resource_uri: str) -> str:
    """Parse BigQuery resource URI into standard dataset.table identifier."""
    parts = resource_uri.replace("//bigquery.googleapis.com/", "").split("/")
    return f"{parts[1]}.{parts[3]}.{parts[5]}"


discovered_assets_map = {
    asset.name.split("/")[-1]: {
        "resource_uri": asset.resource,
        "sql_table_id": parse_bigquery_resource_uri(asset.resource),
    }
    for asset in discovered_raw_assets
}

get_entry_req = dataplex_v1.GetEntryRequest(
    name=canonical_entry_name,
    view=dataplex_v1.EntryView.ALL,
)
catalog_entry_live = catalog_client.get_entry(request=get_entry_req)

live_contract_data = None
if aspect_key in catalog_entry_live.aspects and catalog_entry_live.aspects[aspect_key].data:
    live_contract_data = dict(catalog_entry_live.aspects[aspect_key].data)
else:
    for k, asp in catalog_entry_live.aspects.items():
        if (asp.aspect_type == aspect_type_name or k.endswith(ASPECT_TYPE_ID)) and asp.data:
            live_contract_data = dict(asp.data)
            break

if not live_contract_data:
    raise RuntimeError(
        f"Data Contract Aspect [{aspect_key}] not found on live Knowledge Catalog Entry `{canonical_entry_name}`. "
        f"Available aspects: {list(catalog_entry_live.aspects.keys())}."
    )

grounding_context = {
    "data_product_id": DATA_PRODUCT_ID,
    "display_name": live_product.display_name,
    "description": live_product.description,
    "labels": dict(live_product.labels),
    "discovered_assets": discovered_assets_map,
    "data_contract_sla": {
        "refresh_cadence_cron": live_contract_data.get("refresh_cadence_cron"),
        "freshness_threshold_hours": int(live_contract_data.get("freshness_threshold_hours", 24)),
        "schema_stability_tier": live_contract_data.get("schema_stability_tier"),
    },
    "runtime_telemetry": {
        "observed_table": f"{PROJECT_ID}.{DATASET_ID}.customer_churn_summary",
        "observed_data_age_hours": active_age_hours,
        "is_within_sla_threshold": active_sla_passed,
    },
    "golden_query_sql": live_contract_data.get("golden_query_sql"),
}

user_analytical_prompt = (
    "Generate a BigQuery SQL query to retrieve the top 5 high risk churned customers "
    "sorted by credit limit in descending order using the certified analytical view."
)

gemini_system_instruction = (
    "You are an enterprise AI data assistant. Generate executable BigQuery SQL strictly grounded "
    "in the live discovered Data Product assets and the verified Data Contract Aspect retrieved from Knowledge Catalog. "
    "When certified analytical views are available in `discovered_assets`, prefer them over raw tables to leverage pre-filtered metrics. "
    "Adhere strictly to the certified Golden Query templates."
)

prompt_content = f"""
Live Cloud Data Product Metadata & Catalog Aspect Contract:
{json.dumps(grounding_context, indent=2)}

User Request:
{user_analytical_prompt}
"""

response = gemini_client.models.generate_content(
    model=MODEL_NAME,
    contents=prompt_content,
    config=types.GenerateContentConfig(
        system_instruction=gemini_system_instruction,
        response_mime_type="application/json",
        response_schema=GroundedQueryResponse,
    ),
)

grounded_result: GroundedQueryResponse = GroundedQueryResponse.model_validate_json(response.text)

print("================================================================================")
print("                   AI AGENT GROUNDED QUERY GENERATION RESULT                    ")
print("================================================================================")
print(f"Target Product      : {grounded_result.data_product_id}")
print(f"Target Asset ID     : {grounded_result.target_asset_name}")
print(f"Target Asset Table  : {grounded_result.target_asset_table}")
print(f"Glossary Terms      : {', '.join(grounded_result.glossary_terms_applied)}")
print(f"Contract SLA Status : {'Valid' if grounded_result.contract_sla_satisfied else 'Invalid'}")
print("\nGenerated SQL Query :")
print("--------------------------------------------------------------------------------")
print(grounded_result.sql_query)
print("--------------------------------------------------------------------------------")
print(f"Agent Reasoning     : {grounded_result.reasoning_summary}")
```

---

## BigQuery dry-run guardrail and verified execution

Before sending LLM-generated SQL to execution, validate the query using BigQuery's **Dry-Run** capability (`QueryJobConfig(dry_run=True)`).

The dry run:
* Verifies SQL syntax and schema compatibility without executing the query.
* Returns `total_bytes_processed` to estimate billing cost.

Once the dry run succeeds, the query executes safely against BigQuery.

```python
# BigQuery dry-run guardrail and safe query execution
print("Executing BigQuery dry-run safety guardrail...")

dry_run_job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)

dry_run_job = bq_client.query(grounded_result.sql_query, job_config=dry_run_job_config)
estimated_bytes = dry_run_job.total_bytes_processed
print(f"  ✓ Dry-run passed: Valid SQL syntax.")
print(f"  ✓ Estimated scan : {estimated_bytes} bytes ({estimated_bytes / (1024 * 1024):.4f} MB)")

print("\nExecuting verified SQL on BigQuery...")
query_job = bq_client.query(grounded_result.sql_query)
df_results = query_job.to_dataframe()

print(f"\nQuery returned {len(df_results)} certified records:")
print(tabulate(df_results, headers="keys", tablefmt="psql", showindex=False))
```

---

## Clean teardown and resource cleanup

To ensure zero leftover billing costs on Google Cloud, delete all created resources in strict reverse dependency order:
* Knowledge Catalog Data Assets
* Knowledge Catalog Data Product
* Knowledge Catalog Aspect Type
* BigQuery Dataset (with all tables and views)
* Cloud Storage Staging Bucket

```python
# Resource cleanup
from google.api_core.exceptions import NotFound

print("=======================================================")
print("  Executing Knowledge Catalog and BigQuery cleanup...  ")
print("=======================================================")

if "assets_to_bundle" in locals() and "data_product_client" in locals() and "data_product_name" in locals():
    for asset in assets_to_bundle:
        asset_full_name = f"{data_product_name}/dataAssets/{asset['id']}"
        try:
            op = data_product_client.delete_data_asset(name=asset_full_name)
            if hasattr(op, "result"):
                op.result()
            print(f"Cleaned up Data Asset: [{asset['id']}]")
        except NotFound:
            print(f"Cleaned up Data Asset: [{asset['id']}] (Already Deleted)")
        except Exception as e:
            print(f"Warning: Failed to delete asset [{asset['id']}] ({e})")

if "data_product_client" in locals() and "data_product_name" in locals():
    try:
        op = data_product_client.delete_data_product(name=data_product_name)
        if hasattr(op, "result"):
            op.result()
        print(f"Cleaned up Data Product: [{DATA_PRODUCT_ID}]")
    except NotFound:
        print(f"Cleaned up Data Product: [{DATA_PRODUCT_ID}] (Already Deleted)")
    except Exception as e:
        print(f"Warning: Failed to delete data product [{DATA_PRODUCT_ID}] ({e})")

if "catalog_client" in locals() and "aspect_type_name" in locals():
    try:
        op = catalog_client.delete_aspect_type(name=aspect_type_name)
        if hasattr(op, "result"):
            op.result()
        print(f"Cleaned up Aspect Type: [{ASPECT_TYPE_ID}]")
    except NotFound:
        print(f"Cleaned up Aspect Type: [{ASPECT_TYPE_ID}] (Already Deleted)")
    except Exception as e:
        print(f"Warning: Failed to delete aspect type [{ASPECT_TYPE_ID}] ({e})")

if "bq_client" in locals() and "dataset_ref" in locals():
    bq_client.delete_dataset(dataset_ref, delete_contents=True, not_found_ok=True)
    print(f"Cleaned up BigQuery dataset: `{PROJECT_ID}.{DATASET_ID}`")

if "storage_client" in locals() and "BUCKET_NAME" in locals():
    try:
        b = storage_client.get_bucket(BUCKET_NAME)
        blobs = list(b.list_blobs())
        if blobs:
            b.delete_blobs(blobs)
        b.delete()
        print(f"Cleaned up Cloud Storage staging bucket: `gs://{BUCKET_NAME}`")
    except Exception as e:
        print(f"Notice: Staging bucket cleanup ({e})")

print("\nCleanup complete! Environment cleanly reset with zero leftover cloud billing resources.")
```

---

## Summary and production deployment considerations

### Summary of achievements
* **Decentralized Data Product Governance**: Created domain-aligned Data Products and Data Assets inside Knowledge Catalog.
* **Codified Data Contracts**: Defined custom Aspect Types to enforce SLAs and store certified Golden Query templates directly in Knowledge Catalog.
* **Deterministic SLA Verification**: Evaluated real in-table business timestamps, verifying both compliant and breached states.
* **Grounding with Live Catalog Metadata**: Fetched custom Aspect schemas dynamically, enabling zero-hallucination SQL generation with Gemini.
* **Safe Execution Guardrails**: Enforced BigQuery dry runs to validate syntax and estimate costs before running queries.

### Production best practices
1. **Automated CI/CD Contract Testing**: Integrate Knowledge Catalog Aspect checks into deployment pipelines to prevent breaking schema changes before they reach downstream consumers.
2. **Catalog-Driven Semantic Layers**: Centralize business metric definitions in Knowledge Catalog Aspect Types so all internal AI agents and BI tools query a single source of truth.
3. **Continuous SLA Alerting**: Configure Cloud Monitoring alerts on `TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(ingestion_timestamp), HOUR)` to notify platform owners when Data Contracts are breached.
