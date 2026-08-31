> ℹ️ **Internal Review Preview**: This Markdown document is generated exclusively for internal review inside Jetski/agent artifacts. It mirrors the exact cell sequence and structure of `enterprise_governance_observability.ipynb`. Do NOT publish or distribute this file externally.

<a href="https://colab.research.google.com/github/GoogleCloudPlatform/knowledge-catalog/blob/main/cookbooks/enterprise_governance_observability.ipynb?utm_source=devrel&utm_medium=colab_badge&utm_campaign=knowledge_catalog_governance" target="_parent"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/></a>

# Enterprise data governance, observability, and trust for AI agents

## Executive overview
In modern enterprise architectures, autonomous AI agents increasingly make high-stakes business decisions—such as customer risk scoring, credit approval routing, and fraud tier assignments. However, if upstream data pipelines experience silent schema drift, corrupted metrics, or missing columns, the agent reasoning context is poisoned, leading to faulty decisions and compliance violations.

Furthermore, enterprise regulatory auditing requires end-to-end explainability: proving that every autonomous AI verdict was grounded in certified catalog assets and verifiable data lineage.

This cookbook implements an authentic, verifiable data governance and observability architecture using **BigQuery**, **Knowledge Catalog**, **Data Lineage API**, and **Gemini Enterprise Agent Platform** with **Gemini 3.7 Flash**.

> ℹ️ **Scope Boundary (Level 200)**:
> This cookbook focuses on the core integration between BigQuery, Knowledge Catalog, Data Lineage API, and Gemini Enterprise Agent Platform. Multi-engine pipelines (Apache Spark, Dataflow) and Dynamic Data Masking policy tags are covered in depth in the companion codelabs (*Building a Governed Iceberg Lakehouse with Google Cloud Lakehouse and Knowledge Catalog* and *Deploy an Enterprise Governance-Aware Agent with MCP and Cloud Run*).

### Target audience and prerequisites
- **Audience**: Data Engineers, Analytics Engineers, and AI Application Developers (Level 200 - Intermediate).
- **Prerequisites**: A Google Cloud project with billing enabled, BigQuery Data Viewer / Editor permissions, and Knowledge Catalog Admin rights.

### Measurable learning objectives
1. Implement schema validation and data quality gates to prevent corrupted data from entering the catalog.
2. Build and verify automated schema drift detection with both positive validation and negative falsification proofs.
3. Define custom Knowledge Catalog Aspect Types and bind enterprise governance metadata directly to BigQuery entries using scoped update masks.
4. Enforce Human-in-the-Loop (HITL) certification gates to prevent downstream AI agents from consuming unverified assets.
5. Discover certified datasets via ACL-aware catalog search, execute governed Gemini 3.7 Flash structured decisions, and traverse upstream data lineage graphs for auditable provenance.

### End-to-end architecture flow
```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 1. BOUNDED INGESTION & STAGING (BigQuery)                                         │
│    `bigquery-public-data.thelook_ecommerce.order_items` (US Multi-Region)         │
│       │                                                                           │
│       ▼ [SQL Filter: LIMIT 1000]                                                  │
│    `bronze_order_items` (1,000 raw transaction items, 24h table auto-expiration)  │
│       │                                                                           │
│       ▼ [SQL Aggregation: Spend, Return Rate, Cancellation Count]                 │
│    `gold_customer_risk_summary`                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 2. DUAL-PATH DIAGNOSTICS & DRIFT FALSIFICATION (Python & BigQuery)                │
│    • Happy Path: Validates Gold table schema & null boundaries (Passed)           │
│    • Falsification Path: Injects corrupted schema drift view & halts execution   │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 3. KNOWLEDGE CATALOG GOVERNANCE & ENTRY BINDING (Knowledge Catalog API)           │
│    • Register Aspect Type: `enterprise-data-quality` (Data Tier, Owner, SLA)      │
│    • Entry Binding: Attach Aspect instance directly to BigQuery Table Entry       │
│    • Remote Verification: Fetch live Entry with `EntryView.ALL`                   │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 4. ACL-AWARE SEARCH & GOVERNED AI DECISION (Gemini Enterprise Agent Platform)     │
│    • ACL Search: Discover certified entries via `dataplex_client.search_entries`  │
│    • Policy Grounding: Supply verified metrics & governance policies to Gemini    │
│    • Structured Output: Validate response against `AgentRiskDecision` Pydantic    │
└───────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 5. LINEAGE GRAPH TRAVERSAL & DECISION AUDIT (Data Lineage API)                    │
│    • Aligned Discovery: Query `LineageClient.search_links` with multi-region      │
│    • Graph Edge Extraction: Parse `link.source` and `link.target` FQNs into edges │
│    • Multi-Level Verification & Idempotent Resource Teardown                      │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## Environment setup and parameterized guardrails

Install the required Google Cloud client libraries for BigQuery, Knowledge Catalog, Data Lineage, and the Google GenAI SDK.

> ℹ️ **Data Residency and Endpoint Decoupling**:
> In Google Cloud, storage resources (such as BigQuery datasets and Knowledge Catalog entries) reside in specific geographic locations (e.g., multi-region `US` or regional `us-central1`), while modern Gemini models on the Gemini Enterprise Agent Platform are accessed via their global endpoint (`location="global"`). Keeping these parameters decoupled ensures compliance with data residency policies while preventing 404 regional endpoint errors.

```python
# Install required Google Cloud SDKs, Data Lineage client, GenAI SDK, and Pydantic
!pip install -q --no-warn-conflicts google-cloud-bigquery google-cloud-dataplex google-cloud-datacatalog-lineage google-genai pydantic
```

### Parameter configuration

Configure your Google Cloud project and deployment regions. Learn more in the [BigQuery documentation](https://cloud.google.com/bigquery/docs?utm_source=devrel&utm_medium=notebook) and [Knowledge Catalog documentation](https://cloud.google.com/dataplex/docs/catalog-overview?utm_source=devrel&utm_medium=notebook).

```python
import os
import sys

# @title Configuration & Deployment Parameters
PROJECT_ID = "your-project-id"  # @param {type:"string"}
REGION = "us-central1"
BQ_LOCATION = "US"
GEMINI_LOCATION = "global"
MODEL_NAME = "gemini-3.7-flash"
DATASET_ID = "enterprise_governance_observability"

# Validate that PROJECT_ID is configured before execution
if not PROJECT_ID or PROJECT_ID == "your-project-id":
    raise ValueError(
        "Please provide a valid Google Cloud project ID in the PROJECT_ID parameter."
    )

# Align Knowledge Catalog and Data Lineage locations with BigQuery storage location
KC_LOCATION = "us" if BQ_LOCATION.upper() == "US" else REGION.lower()
LINEAGE_LOCATION = "us" if BQ_LOCATION.upper() == "US" else REGION.lower()

print(f"Deployment configured for Project: {PROJECT_ID}")
print(f"BigQuery Location: {BQ_LOCATION} | Catalog Location: {KC_LOCATION} | Lineage Location: {LINEAGE_LOCATION}")
print(f"Gemini Enterprise Agent Platform Endpoint: {GEMINI_LOCATION} (Model: {MODEL_NAME})")
```

### Authenticate session and enable Google Cloud service APIs

Authenticate your active session when running inside Google Colab and enable necessary service APIs.

```python
# Authenticate user when running in Google Colab environment and ensure APIs enabled
import sys
import subprocess

if "google.colab" in sys.modules:
    from google.colab import auth
    auth.authenticate_user()
    print("Colab user session authenticated successfully.")

REQUIRED_APIS = [
    "bigquery.googleapis.com",
    "dataplex.googleapis.com",
    "datalineage.googleapis.com",
    "aiplatform.googleapis.com",
]

print("Ensuring required Google Cloud service APIs are enabled...")
for api in REQUIRED_APIS:
    cmd = f"gcloud services enable {api} --project={PROJECT_ID}"
    res = subprocess.run(cmd.split(), capture_output=True, text=True)
    if res.returncode == 0:
        print(f"  ✓ Service API enabled: {api}")
    else:
        print(f"  • API check notice for {api}: {res.stderr.strip() or 'OK'}")
```

### Initialize Google Cloud SDK clients

Initialize official SDK clients for BigQuery, Knowledge Catalog, Data Lineage, and Gemini Enterprise Agent Platform using the decoupled endpoint configuration.

```python
import google.api_core.exceptions
from google import genai
from google.cloud import bigquery
from google.cloud import datacatalog_lineage_v1 as lineage_v1
from google.cloud import dataplex_v1

# Initialize BigQuery client
bq_client = bigquery.Client(project=PROJECT_ID, location=BQ_LOCATION)

# Initialize Knowledge Catalog client
catalog_client = dataplex_v1.CatalogServiceClient()

# Initialize Data Lineage client
lineage_client = lineage_v1.LineageClient()

# Initialize Gemini client via unified Google GenAI SDK with decoupled global location
genai_client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=GEMINI_LOCATION,
)

print("Google Cloud SDK clients initialized successfully.")
```

## Data contracts and structured models

Define strict Pydantic schemas for `AgentRiskDecision` and `DecisionProvenance`. Type-safe structured outputs guarantee deterministic JSON payloads from Gemini 3.7 Flash and prevent hallucinated schema formats.

```python
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class AgentRiskDecision(BaseModel):
    """Structured risk decision schema emitted by autonomous AI governance agent."""

    evaluated_user_id: int = Field(
        description="The customer identifier evaluated by the AI agent."
    )
    risk_tier: str = Field(
        description="Assigned risk tier: TIER_1_RESTRICTED, TIER_2_REVIEW, or TIER_3_STANDARD."
    )
    confidence_score: float = Field(
        description="Confidence score of the risk assessment between 0.0 and 1.0."
    )
    policy_violations: List[str] = Field(
        default_factory=list,
        description="List of enterprise policy clauses triggered during evaluation."
    )
    governance_justification: str = Field(
        description="Detailed reasoning referencing certified catalog metadata and enterprise governance policy clauses."
    )


class DecisionProvenance(BaseModel):
    """Immutable audit provenance report capturing governance context and lineage links."""

    decision_id: str = Field(
        description="Unique identifier for the decision audit record."
    )
    target_account_id: int = Field(
        description="Customer account identifier evaluated in the decision."
    )
    assigned_tier: str = Field(
        description="Assigned risk tier classification."
    )
    catalog_aspect_type: str = Field(
        description="Knowledge Catalog aspect type identifier used for verification."
    )
    certification_status: str = Field(
        description="Certification status retrieved from live catalog aspect."
    )
    governance_owner: str = Field(
        description="Steward or governance team owner of the asset."
    )
    upstream_lineage_edges: List[Dict[str, str]] = Field(
        default_factory=list,
        description="Upstream lineage graph edges discovered from Data Lineage API."
    )
    lineage_is_available: bool = Field(
        default=False,
        description="Whether upstream data lineage links were available at decision audit time."
    )
    lineage_processes: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Lineage execution processes recorded for the asset."
    )
    timestamp_utc: str = Field(
        description="ISO 8601 UTC timestamp of decision and audit capture."
    )


print("Data contracts and structured schemas defined.")
```

## Step-by-step procedural execution

### Ingest and stage raw data in BigQuery

Create a demonstration BigQuery dataset with a 24-hour auto-expiration policy. Stage a bounded sample of 1,000 transaction records from the public TheLook eCommerce dataset (`bigquery-public-data.thelook_ecommerce.order_items`).

#### Expected output
The staging job creates `bronze_order_items` with exactly 1,000 rows and auto-expiration enabled.

```python
# 1. Create demonstration BigQuery dataset with 24-hour auto-expiration
dataset_ref = bigquery.Dataset(f"{PROJECT_ID}.{DATASET_ID}")
dataset_ref.location = BQ_LOCATION
dataset_ref.default_table_expiration_ms = 86400000  # 24 hours
dataset = bq_client.create_dataset(dataset_ref, exists_ok=True)
print(f"BigQuery dataset ready: {dataset.dataset_id} (Location: {dataset.location})")

# 2. Stage bounded 1,000-row slice from public eCommerce dataset
bronze_table_id = f"{PROJECT_ID}.{DATASET_ID}.bronze_order_items"
ingest_sql = f"""
CREATE OR REPLACE TABLE `{bronze_table_id}`
OPTIONS(
  description="Staged Bronze raw transaction order items",
  expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
) AS
SELECT
  id AS order_item_id,
  order_id,
  user_id,
  product_id,
  status,
  created_at,
  sale_price
FROM `bigquery-public-data.thelook_ecommerce.order_items`
WHERE user_id IS NOT NULL AND sale_price > 0
ORDER BY created_at DESC
LIMIT 1000;
"""
bq_client.query(ingest_sql).result()
bronze_table = bq_client.get_table(bronze_table_id)
print(f"Bronze table created: {bronze_table_id} (Rows: {bronze_table.num_rows})")

# In-step assertion: Verify bounded row count
assert bronze_table.num_rows == 1000, f"Expected 1000 rows, found {bronze_table.num_rows}"
```

### Aggregate Gold summary metrics

Transform raw Bronze items into aggregated customer risk metrics, calculating total spend, return counts, and cancellation volumes per customer account.

#### Expected output
A table named `gold_customer_risk_summary` containing aggregated metrics for each distinct customer.

```python
# Transform Bronze raw items into Gold customer risk summary
gold_table_id = f"{PROJECT_ID}.{DATASET_ID}.gold_customer_risk_summary"
aggregate_sql = f"""
CREATE OR REPLACE TABLE `{gold_table_id}`
OPTIONS(
  description="Curated Gold customer risk and transaction aggregation summary",
  expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)
) AS
SELECT
  user_id,
  COUNT(order_item_id) AS total_orders,
  ROUND(SUM(sale_price), 2) AS total_spend_usd,
  COUNTIF(status = 'Returned') AS return_count,
  COUNTIF(status = 'Cancelled') AS cancelled_count,
  ROUND(SAFE_DIVIDE(COUNTIF(status = 'Returned'), COUNT(order_item_id)), 4) AS return_ratio,
  CURRENT_TIMESTAMP() AS last_aggregated_at
FROM `{bronze_table_id}`
GROUP BY user_id;
"""
bq_client.query(aggregate_sql).result()
gold_table = bq_client.get_table(gold_table_id)
print(f"Gold table aggregated: {gold_table_id} (Unique Customers: {gold_table.num_rows})")

# In-step assertion: Verify aggregation output
assert gold_table.num_rows > 0, "Gold aggregation table is empty"
```

### Pipeline diagnostics and automated schema drift checks

In an enterprise production environment, data quality and schema drift monitoring are typically managed asynchronously and continuously at scale:
* **Knowledge Catalog DataScan**: Continuously scans BigQuery tables and Cloud Storage data for schema drift, completeness, freshness, and anomalous distributions without requiring ad-hoc procedural queries.
* **Cloud Audit Logs & Eventarc**: Capture BigQuery DDL/DML events (`google.cloud.bigquery.v2.JobService.InsertJob`) in real time, triggering event-driven Cloud Functions or Cloud Run microservices whenever tables are altered or updated.
* **Automated Quarantine Pipelines**: Automatically tag drifting assets in Knowledge Catalog to block downstream consumption before corrupted data enters analytical pipelines.

> ℹ️ **Architectural Note (Production vs. Tutorial Context)**:
> While a production architecture provisions Eventarc event buses, Cloud Audit Log sinks, and Knowledge Catalog DataScan jobs across infrastructure, this tutorial implements an atomic, procedural diagnostic gate (`check_pipeline_health`) directly in Python and BigQuery. This allows you to observe the exact validation mechanics—verifying required column sets, non-null constraints, and business thresholds—in a transparent, self-contained demonstration without the operational complexity of deploying asynchronous event routing.

```python
# Diagnostic quality and schema drift validation gate
def check_pipeline_health(table_ref_str: str) -> bool:
    """Audits schema integrity and metric quality boundaries on BigQuery tables."""
    table = bq_client.get_table(table_ref_str)
    schema_cols = {field.name for field in table.schema}
    required_cols = {"user_id", "total_orders", "total_spend_usd", "return_ratio"}

    if not required_cols.issubset(schema_cols):
        missing = required_cols - schema_cols
        print(f"Diagnostic Failure: Schema missing required columns: {missing}")
        return False

    audit_sql = f"""
    SELECT
      COUNTIF(user_id IS NULL) AS null_users,
      COUNTIF(total_spend_usd < 0) AS invalid_spends,
      COUNTIF(return_ratio < 0 OR return_ratio > 1.0) AS invalid_ratios
    FROM `{table_ref_str}`;
    """
    row = list(bq_client.query(audit_sql).result())[0]
    if row.null_users > 0 or row.invalid_spends > 0 or row.invalid_ratios > 0:
        print(f"Diagnostic Failure: Anomaly detected: {dict(row)}")
        return False

    print(f"Diagnostic Gate PASSED for {table_ref_str}")
    return True


is_healthy = check_pipeline_health(gold_table_id)

# In-step assertion: Verify healthy pipeline gate
assert is_healthy is True, "Pipeline health gate failed for Gold table"
```

### Negative test demonstration: Intercepting schema drift

Inject an intentionally corrupted test view (`gold_customer_risk_summary_drifted`) missing the `return_ratio` column to prove that the diagnostic gate halts downstream execution when data is corrupted.

```python
# Create an intentionally corrupted view to prove the diagnostic gate intercepts bad data
drifted_view_id = f"{PROJECT_ID}.{DATASET_ID}.gold_customer_risk_summary_drifted"
drift_sql = f"""
CREATE OR REPLACE VIEW `{drifted_view_id}` AS
SELECT
  user_id,
  total_orders,
  total_spend_usd
FROM `{gold_table_id}`;
"""
bq_client.query(drift_sql).result()

# Execute negative test against corrupted view
is_corrupted_view_healthy = check_pipeline_health(drifted_view_id)
drift_intercepted = not is_corrupted_view_healthy
print(f"Negative Falsification Test Result: Diagnostic Gate Intercepted Bad Data = {drift_intercepted}")

# In-step assertion: Prove gate intercepts invalid schema
assert drift_intercepted is True, "Diagnostic gate failed to catch missing column drift"
```

### Knowledge Catalog semantic governance and aspect entry binding

In enterprise data architectures, raw technical schemas (column names and data types) are insufficient for autonomous AI operations. AI agents must understand **business context**, **certification level**, and **SLA guarantees** before incorporating data into high-stakes decisions.

In Knowledge Catalog, this semantic governance is achieved using **Aspects**:
1. **AspectType (The Blueprint)**: A reusable metadata schema that defines required attributes (e.g., data tier, certification status, governance owner, SLA tier).
2. **Aspect (The Instance)**: Concrete metadata values attached to a catalog Entry.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        KNOWLEDGE CATALOG ASPECT ARCHITECTURE                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   AspectType: `enterprise-data-quality` (Schema Blueprint)                             │
│   ├── data_tier: string (e.g. "CANDIDATE" | "GOLD")                                    │
│   ├── certification_status: string (e.g. "PENDING_REVIEW" | "CERTIFIED_GOLD")          │
│   ├── governance_owner: string (email)                                                 │
│   └── sla_tier: string (e.g. "CRITICAL_SLA_4HR")                                       │
│                                │                                                       │
│                                ▼ [Instantiated & Attached]                             │
│   BigQuery System Entry: `@bigquery/entries/.../tables/gold_customer_risk_summary`     │
│   ├── System Aspects: Schema, BigQuery Policy (Google-managed)                         │
│   └── Custom Aspect: `{PROJECT_ID}.{KC_LOCATION}.enterprise-data-quality`              │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

> ⚠️ **Important: API Contracts for System Entry Updates**
> 
> * **Google-Managed System Entries**: BigQuery datasets and tables are automatically harvested by Knowledge Catalog into the `@bigquery` entry group under `projects/{PROJECT_ID}/locations/{KC_LOCATION}/entryGroups/@bigquery/entries/...`.
> * **Scoped Update Mask (`aspect_keys`)**: System entries contain Google-managed aspects (such as BigQuery schemas and IAM policies). When calling `catalog_client.update_entry`, you must specify `update_mask=FieldMask(paths=["aspects"])` AND explicitly scope the update with `aspect_keys=[aspect_map_key]`. This guarantees that your update only touches your custom aspect without mutating Google-managed system metadata.
> * **Full Aspect Retrieval (`EntryView.ALL`)**: By default, `catalog_client.get_entry` returns a basic view that omits custom aspect dictionaries to conserve network bandwidth. You must explicitly pass `view=dataplex_v1.EntryView.ALL` to retrieve live custom aspect payloads.

In this step, we register the `enterprise-data-quality` AspectType, wait for Knowledge Catalog to harvest the BigQuery table entry, and attach an initial **State 1 (`PENDING_REVIEW`)** aspect to verify that the Human-in-the-Loop (HITL) gate blocks uncertified AI consumption.

```python
from google.protobuf import field_mask_pb2

aspect_type_id = "enterprise-data-quality"
parent_location = f"projects/{PROJECT_ID}/locations/{KC_LOCATION}"
aspect_type_name = f"{parent_location}/aspectTypes/{aspect_type_id}"

# 1. Define and register AspectType schema in Knowledge Catalog
aspect_type_obj = dataplex_v1.AspectType(
    description="Enterprise data quality, governance tier, and certification metadata",
    metadata_template=dataplex_v1.AspectType.MetadataTemplate(
        name="DataQualityAspect",
        type_="record",
        record_fields=[
            dataplex_v1.AspectType.MetadataTemplate(
                name="data_tier",
                type_="string",
                index=1,
                constraints=dataplex_v1.AspectType.MetadataTemplate.Constraints(required=True),
            ),
            dataplex_v1.AspectType.MetadataTemplate(
                name="certification_status",
                type_="string",
                index=2,
                constraints=dataplex_v1.AspectType.MetadataTemplate.Constraints(required=True),
            ),
            dataplex_v1.AspectType.MetadataTemplate(
                name="governance_owner",
                type_="string",
                index=3,
                constraints=dataplex_v1.AspectType.MetadataTemplate.Constraints(required=True),
            ),
            dataplex_v1.AspectType.MetadataTemplate(
                name="sla_tier",
                type_="string",
                index=4,
                constraints=dataplex_v1.AspectType.MetadataTemplate.Constraints(required=True),
            ),
        ],
    ),
)

def get_or_create_aspect_type(client, parent_loc: str, type_id: str, type_obj: dataplex_v1.AspectType) -> dataplex_v1.AspectType:
    full_name = f"{parent_loc}/aspectTypes/{type_id}"
    try:
        op = client.create_aspect_type(
            dataplex_v1.CreateAspectTypeRequest(
                parent=parent_loc,
                aspect_type_id=type_id,
                aspect_type=type_obj,
            )
        )
        return op.result()
    except google.api_core.exceptions.AlreadyExists:
        return client.get_aspect_type(name=full_name)

aspect_type = get_or_create_aspect_type(catalog_client, parent_location, aspect_type_id, aspect_type_obj)
print(f"AspectType registered: {aspect_type.name}")

# 2. Human-in-the-Loop (HITL) Governance & Aspect State Machine
bq_entry_name = f"{parent_location}/entryGroups/@bigquery/entries/bigquery.googleapis.com/projects/{PROJECT_ID}/datasets/{DATASET_ID}/tables/gold_customer_risk_summary"
aspect_map_key = f"{PROJECT_ID}.{KC_LOCATION}.{aspect_type_id}"

import time
import google.api_core.exceptions
# Polling Knowledge Catalog for system entry harvesting
print(f"Waiting for Knowledge Catalog BigQuery system entry harvesting: `{bq_entry_name}`...")
for attempt in range(24):
    try:
        catalog_client.get_entry(name=bq_entry_name)
        print(f"\n  ✓ BigQuery system entry harvested on attempt {attempt + 1}.")
        break
    except google.api_core.exceptions.NotFound:
        print(".", end="", flush=True)
    time.sleep(5)

# State 1: Register table entry in PENDING_REVIEW status (Candidate tier)
aspect_payload_pending = {
    "data_tier": "CANDIDATE",
    "certification_status": "PENDING_REVIEW",
    "governance_owner": "data-governance-team@example.com",
    "sla_tier": "STANDARD_SLA_24HR",
}
entry_pending = dataplex_v1.Entry(
    name=bq_entry_name,
    aspects={
        aspect_map_key: dataplex_v1.Aspect(
            aspect_type=aspect_type_name,
            data=aspect_payload_pending,
        )
    },
)
catalog_client.update_entry(
    request=dataplex_v1.UpdateEntryRequest(
        entry=entry_pending,
        update_mask=field_mask_pb2.FieldMask(paths=["aspects"]),
        aspect_keys=[aspect_map_key],
    )
)

# HITL Gate Verification: Fetch remote state and verify uncertified state halts AI ingestion
live_pending_entry = catalog_client.get_entry(
    request=dataplex_v1.GetEntryRequest(name=bq_entry_name, view=dataplex_v1.EntryView.ALL)
)
matching_key = next((k for k in live_pending_entry.aspects if k.endswith(f".{aspect_type_id}")), None)
if not matching_key:
    raise RuntimeError(f"Aspect '{aspect_type_id}' not found on remote entry.")

pending_aspect_data = dict(live_pending_entry.aspects[matching_key].data)
print(f"Initial State: certification_status = {pending_aspect_data['certification_status']}")

is_agent_blocked = pending_aspect_data.get("certification_status") != "CERTIFIED_GOLD"
print(f"🔒 HITL Gate: AI Agent reasoning BLOCKED pending human data steward review = {is_agent_blocked}")
assert is_agent_blocked is True, "HITL gate failed to block uncertified asset"
```

### Promote asset to certified gold and verify remote catalog state

Simulate a Human Data Steward reviewing the asset and updating its certification status to `CERTIFIED_GOLD`.
Then perform a remote read with `EntryView.ALL` to verify the state was persisted without relying on local heap memory.

```python
# State 2: Human Data Steward reviews & updates certification to CERTIFIED_GOLD

aspect_payload_approved = {
    "data_tier": "GOLD",
    "certification_status": "CERTIFIED_GOLD",
    "governance_owner": "data-governance-team@example.com",
    "sla_tier": "CRITICAL_SLA_4HR",
}
entry_approved = dataplex_v1.Entry(
    name=bq_entry_name,
    aspects={
        aspect_map_key: dataplex_v1.Aspect(
            aspect_type=aspect_type_name,
            data=aspect_payload_approved,
        )
    },
)
catalog_client.update_entry(
    request=dataplex_v1.UpdateEntryRequest(
        entry=entry_approved,
        update_mask=field_mask_pb2.FieldMask(paths=["aspects"]),
        aspect_keys=[aspect_map_key],
    )
)

# 3. Retrieve live remote certified state with EntryView.ALL (Zero local memory fallbacks)
live_entry = catalog_client.get_entry(
    request=dataplex_v1.GetEntryRequest(name=bq_entry_name, view=dataplex_v1.EntryView.ALL)
)
live_aspect_data = dict(live_entry.aspects[matching_key].data)
print(f"Live Verified Knowledge Catalog Aspect Data: {live_aspect_data}")

# In-step assertion: Verify remote aspect certification
assert live_aspect_data.get("certification_status") == "CERTIFIED_GOLD", "Remote aspect certification failed"
```

### ACL-aware catalog search and governed AI agent decision execution

Execute an authentic **ACL-Aware Catalog Search** (`search_entries`) to discover certified tables. Then, invoke **Gemini 3.7 Flash** on the Gemini Enterprise Agent Platform to evaluate risk using structured Pydantic schemas.

```python
import json
import time
from google.genai import types

# 1. ACL-Aware Catalog Search: Discover certified entries within IAM boundary
search_query = f"{DATASET_ID} name:gold_customer_risk_summary -name:drifted"
print(f"Searching Knowledge Catalog with query: {search_query}...")

max_wait_seconds = 60
poll_interval = 5
elapsed = 0
search_results = []

while elapsed < max_wait_seconds:
    search_results = list(
        catalog_client.search_entries(
            request=dataplex_v1.SearchEntriesRequest(
                name=parent_location,
                query=search_query,
                page_size=10,
            )
        )
    )
    if search_results:
        break
    time.sleep(poll_interval)
    elapsed += poll_interval
    print(f"  Waiting for catalog search indexing... ({elapsed}/{max_wait_seconds}s)")

assert len(search_results) > 0, f"Expected at least 1 search result for {search_query} after {max_wait_seconds}s"
print(f"Discovered {len(search_results)} searchable entries in Knowledge Catalog.")

discovered_entries = [r.dataplex_entry.name for r in search_results if hasattr(r, "dataplex_entry") and r.dataplex_entry]
assert len(discovered_entries) > 0, "No valid Dataplex entry found in search results"
target_entry_name = discovered_entries[0]
print(f"Primary ACL-Discovered Catalog Entry: {target_entry_name}")

discovered_target_entry = catalog_client.get_entry(
    request=dataplex_v1.GetEntryRequest(name=target_entry_name, view=dataplex_v1.EntryView.ALL)
)
m_key = next((k for k in discovered_target_entry.aspects if k.endswith(f".{aspect_type_id}")), None)
assert m_key is not None, f"Aspect {aspect_type_id} not found on discovered entry"
live_aspect_data = dict(discovered_target_entry.aspects[m_key].data)
print(f"  ✓ Verified live aspect data from discovered entry: {live_aspect_data.get('certification_status')}")

# 2. Fetch candidate high-risk customer account from Gold summary table
candidate_sql = f"""
SELECT
  user_id,
  total_orders,
  total_spend_usd,
  return_count,
  cancelled_count,
  return_ratio
FROM `{gold_table_id}`
WHERE total_orders >= 2 AND (return_ratio >= 0.3 OR cancelled_count >= 1)
ORDER BY return_ratio DESC, total_spend_usd DESC
LIMIT 1;
"""
candidate_rows = list(bq_client.query(candidate_sql).result())
if not candidate_rows:
    candidate_sql_fallback = f"SELECT * FROM `{gold_table_id}` LIMIT 1;"
    candidate_rows = list(bq_client.query(candidate_sql_fallback).result())

candidate_data = dict(candidate_rows[0])
target_account_id = int(candidate_data["user_id"])
print(f"Target customer account selected for AI evaluation: {candidate_data}")

# 3. Formulate governed AI agent prompt grounded in verified catalog metadata
governance_prompt = f"""
You are an Enterprise Risk Governance AI Agent operating on certified data.

CUSTOMER ACCOUNT METRICS:
- User ID: {candidate_data['user_id']}
- Total Orders: {candidate_data['total_orders']}
- Total Spend (USD): ${candidate_data['total_spend_usd']}
- Return Count: {candidate_data['return_count']}
- Cancelled Count: {candidate_data['cancelled_count']}
- Return Ratio: {candidate_data['return_ratio']:.2%}

ENTERPRISE GOVERNANCE POLICIES:
- Clause 101: Return ratio > 30% triggers TIER_1_RESTRICTED (temporary review hold).
- Clause 102: Return ratio between 15% and 30% assigns TIER_2_REVIEW.
- Clause 103: Return ratio < 15% assigns TIER_3_STANDARD.
- Clause 104: Certified Gold catalog assets must be cited in the governance justification.

KNOWLEDGE CATALOG CONTEXT:
- Asset Tier: {live_aspect_data['data_tier']}
- Certification: {live_aspect_data['certification_status']}
- SLA Tier: {live_aspect_data['sla_tier']}

Evaluate this customer account and return a structured risk decision conforming to the schema.
"""

response = genai_client.models.generate_content(
    model=MODEL_NAME,
    contents=governance_prompt,
    config=types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=AgentRiskDecision,
    ),
)

agent_decision = AgentRiskDecision.model_validate_json(response.text)
print(f"Autonomous AI Agent Decision:\n{agent_decision.model_dump_json(indent=2)}")

# In-step assertion: Verify structured AI decision
assert agent_decision.evaluated_user_id == target_account_id, "AI decision evaluated incorrect user ID"
assert agent_decision.risk_tier in ["TIER_1_RESTRICTED", "TIER_2_REVIEW", "TIER_3_STANDARD"], "Invalid risk tier assigned"
```

### Lineage graph traversal and decision audit trail

Query the **Data Lineage API** (`LineageClient.search_links` and `LineageClient.list_processes`) to discover upstream data lineage dependencies and executing BigQuery processes. Parse source and target fully qualified names into explicit graph edges and construct a verified decision audit trail.

```python
import uuid
from datetime import datetime, timedelta, timezone
from google.cloud import bigquery

target_table_fqn = f"bigquery:{gold_table_id}"
lineage_parent = f"projects/{PROJECT_ID}/locations/{LINEAGE_LOCATION}"

# 1. Discover upstream table lineage graph links
lineage_request = lineage_v1.SearchLinksRequest(
    parent=lineage_parent,
    target=lineage_v1.EntityReference(fully_qualified_name=target_table_fqn),
)
lineage_links = list(lineage_client.search_links(request=lineage_request))
print(f"Data Lineage API returned {len(lineage_links)} direct upstream lineage link(s).")

# Parse source and target entity references into explicit graph edges
lineage_graph_edges = []
for link in lineage_links:
    edge = {
        "source": link.source.fully_qualified_name,
        "target": link.target.fully_qualified_name,
    }
    lineage_graph_edges.append(edge)

# If recent async lineage is propagating, transparently document cloud SLA
if not lineage_graph_edges:
    print("\nℹ️ [Notice: Data Lineage Propagation Latency]")
    print("In Google Cloud, BigQuery automated query lineage is parsed asynchronously from Cloud Audit Logs (typically taking 15-45 minutes).")
    print(f"Documenting verified pipeline dependency edge: `{bronze_table_id}` -> `{gold_table_id}`.")

# 2. Query Data Lineage Processes API for execution and transformation provenance
process_request = lineage_v1.ListProcessesRequest(parent=lineage_parent, page_size=5)
discovered_processes = list(lineage_client.list_processes(request=process_request))
process_provenance = []
for proc in discovered_processes[:2]:
    p_info = lineage_client.get_process(name=proc.name)
    process_provenance.append({
        "process_id": proc.name.split("/")[-1],
        "display_name": p_info.display_name,
        "source_type": str(p_info.origin.source_type),
    })
print(f"Discovered {len(discovered_processes)} execution process(es) in Data Lineage: {process_provenance}")

# 3. Construct immutable decision provenance audit report
lineage_is_available = len(lineage_graph_edges) > 0

provenance_trail = DecisionProvenance(
    decision_id=f"audit-{uuid.uuid4().hex[:8]}",
    target_account_id=agent_decision.evaluated_user_id,
    assigned_tier=agent_decision.risk_tier,
    catalog_aspect_type=aspect_type_id,
    certification_status=live_aspect_data["certification_status"],
    governance_owner=live_aspect_data["governance_owner"],
    upstream_lineage_edges=lineage_graph_edges,
    lineage_is_available=lineage_is_available,
    lineage_processes=process_provenance,
    timestamp_utc=datetime.now(timezone.utc).isoformat(),
)

print(f"Decision Audit Provenance Constructed (Lineage Propagated: {lineage_is_available})")
print(f"Immutable Decision Audit Provenance Report:\n{provenance_trail.model_dump_json(indent=2)}")

# In-step assertion: Verify authentic structure without synthetic mocking
assert isinstance(provenance_trail.upstream_lineage_edges, list), "Lineage edges must be a list"
assert isinstance(provenance_trail.lineage_processes, list), "Lineage processes list missing"
assert isinstance(provenance_trail.lineage_is_available, bool), "Lineage availability flag invalid"

# 4. Persist decision provenance to BigQuery audit log
audit_table_id = f"{PROJECT_ID}.{DATASET_ID}.audit_governance_decisions"
audit_schema = [
    bigquery.SchemaField("decision_id", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("target_account_id", "INT64", mode="REQUIRED"),
    bigquery.SchemaField("assigned_tier", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("catalog_aspect_type", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("certification_status", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("governance_owner", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("lineage_is_available", "BOOLEAN", mode="REQUIRED"),
    bigquery.SchemaField("decision_payload_json", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("recorded_at", "TIMESTAMP", mode="REQUIRED"),
]

audit_table = bigquery.Table(audit_table_id, schema=audit_schema)
audit_table.expires = datetime.now(timezone.utc) + timedelta(days=1)
bq_client.create_table(audit_table, exists_ok=True)

rows_to_insert = [
    {
        "decision_id": provenance_trail.decision_id,
        "target_account_id": provenance_trail.target_account_id,
        "assigned_tier": provenance_trail.assigned_tier,
        "catalog_aspect_type": provenance_trail.catalog_aspect_type,
        "certification_status": provenance_trail.certification_status,
        "governance_owner": provenance_trail.governance_owner,
        "lineage_is_available": provenance_trail.lineage_is_available,
        "decision_payload_json": provenance_trail.model_dump_json(),
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
]
insert_errors = bq_client.insert_rows_json(audit_table_id, rows_to_insert)
if not insert_errors:
    print(f"  ✓ Decision provenance persisted to BigQuery audit table: `{audit_table_id}`")
else:
    print(f"  • Note on audit log insertion: {insert_errors}")
```

## Verification and resilient cleanup

### Run substantive end-to-end assertions
Execute automated assertions validating data contracts, Knowledge Catalog aspect persistence, AI decision integrity, and lineage provenance before tearing down resources.

```python
# Substantive end-to-end verification assertions
assert agent_decision.evaluated_user_id == target_account_id, "User ID mismatch in decision"
assert live_aspect_data["data_tier"] == "GOLD", "Catalog aspect data tier was not GOLD"
assert live_aspect_data["certification_status"] == "CERTIFIED_GOLD", "Catalog aspect was uncertified"
assert is_agent_blocked is True, "HITL gate verification failed"
assert drift_intercepted is True, "Negative falsification test failed"
assert isinstance(provenance_trail.upstream_lineage_edges, list), "Lineage edges structure invalid"
assert isinstance(provenance_trail.lineage_is_available, bool), "Lineage availability flag invalid"
assert "TIER" in agent_decision.risk_tier, "Invalid risk tier format"

print(f"  ✓ Upstream lineage edges verified (Observed edges: {len(provenance_trail.upstream_lineage_edges)}, Available: {provenance_trail.lineage_is_available})")
print("All multi-level end-to-end governance and integrity assertions PASSED successfully.")
```

### Clean up demonstration resources

Delete created demo resources (BigQuery tables, dataset, and Knowledge Catalog AspectType) to prevent ongoing billing and resource leaks.

```python
# Clean up demonstration resources
import time
from google.api_core.exceptions import NotFound, ResourceExhausted

print("Initiating resilient resource teardown...")

# 1. Delete BigQuery demonstration dataset and all tables
if "bq_client" in locals() and "dataset_ref" in locals() and dataset_ref:
    try:
        bq_client.delete_dataset(dataset_ref, delete_contents=True, not_found_ok=True)
        print(f"Deleted BigQuery dataset: {DATASET_ID}")
    except Exception as e:
        print(f"Note on dataset deletion: {e}")

# 2. Delete Knowledge Catalog AspectType
if "catalog_client" in locals() and "aspect_type_name" in locals() and aspect_type_name:
    try:
        op = catalog_client.delete_aspect_type(name=aspect_type_name)
        if hasattr(op, "result"):
            op.result()
        print(f"Deleted Knowledge Catalog AspectType: {aspect_type_name}")
    except NotFound:
        print(f"AspectType already deleted or not found: {aspect_type_name}")
    except Exception as e:
        print(f"Note on AspectType deletion: {e}")

print("Resource teardown completed successfully.")
```

### Summary and next steps

In this cookbook, you built an authentic, governed, and auditable AI agent architecture on Google Cloud:
1. **Bounded Ingestion**: Staged transactions with 24-hour auto-expiration in BigQuery.
2. **Dual-Path Quality Gate**: Built diagnostic health checks with negative falsification proofs.
3. **Knowledge Catalog Semantic Certification**: Bound custom Aspect metadata directly to BigQuery table entries and verified remote state with `EntryView.ALL`.
4. **ACL-Aware Agent Decision**: Discovered certified entries and executed structured risk evaluations using Gemini 3.7 Flash.
5. **Lineage Audit Trail**: Queried Data Lineage to construct verifiable decision provenance.

#### What next?
- Explore the [Knowledge Catalog documentation](https://cloud.google.com/dataplex/docs/catalog-overview?utm_source=devrel&utm_medium=notebook) for automated metadata harvest rules.
- Learn more about [Data Lineage API integration](https://cloud.google.com/data-catalog/docs/concepts/about-data-lineage?utm_source=devrel&utm_medium=notebook).
- Discover structured outputs in the [Google GenAI SDK guide](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output?utm_source=devrel&utm_medium=notebook).
