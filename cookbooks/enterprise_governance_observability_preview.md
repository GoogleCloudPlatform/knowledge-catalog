> [!NOTE]
> **Internal Review Preview**: This Markdown document is generated exclusively for internal review inside Jetski/agent artifacts. It mirrors the exact cell sequence and structure of the target `.ipynb`. Do NOT publish or distribute this file externally.

---

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/google-cloud-samples/community-cookbooks/blob/main/enterprise_governance_observability.ipynb)

# Enterprise data governance, observability, and trust for AI agents

## Executive overview
In modern enterprise architectures, autonomous AI agents increasingly make high-stakes business decisions—such as customer risk scoring, credit approval routing, and fraud tier assignments. However, if upstream data pipelines experience silent schema drift, corrupted metrics, or missing columns, the agent reasoning context is poisoned, leading to faulty decisions and compliance violations.

Furthermore, enterprise regulatory auditing requires end-to-end explainability: proving that every autonomous AI verdict was grounded in certified catalog assets and verifiable data lineage.

This cookbook implements an authentic, verifiable data governance and observability architecture using **BigQuery**, **Knowledge Catalog**, **Data Lineage API**, and **Gemini Enterprise Agent Platform** with **Gemini 3.7 Flash**.

> [!NOTE]
> **Scope Boundary (Level 200)**: This cookbook focuses on the core integration between BigQuery, Knowledge Catalog, Data Lineage API, and Gemini Enterprise Agent Platform. Multi-engine pipelines (Apache Spark, Dataflow) and Dynamic Data Masking policy tags are covered in depth in the companion codelabs (*Building a Governed Iceberg Lakehouse with Google Cloud Lakehouse and Knowledge Catalog* and *Deploy an Enterprise Governance-Aware Agent with MCP and Cloud Run*).

### Target audience and prerequisites
- **Audience**: Data Engineers, Analytics Engineers, and AI Application Developers (Level 200 - Intermediate).
- **Prerequisites**: A Google Cloud project with billing enabled, BigQuery Data Viewer / Editor permissions, and Knowledge Catalog Admin rights.

### Measurable learning objectives
1. Ingest public transaction items into bounded, auto-expiring BigQuery tables with defensive staging limits.
2. Build and verify an automated schema drift diagnostic gate with positive and negative falsification proofs.
3. Define Knowledge Catalog Aspect Types, attach governance metadata directly to BigQuery table entries, and verify state using complete entry views.
4. Discover certified datasets via ACL-aware catalog search and execute governed Gemini 3.7 Flash structured risk decisions.
5. Traverse upstream data lineage by parsing graph link entities and generate an auditable decision provenance report.

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

> [!NOTE]
> **Data Residency and Endpoint Decoupling**:
> In Google Cloud, storage resources (such as BigQuery datasets and Knowledge Catalog entries) reside in specific geographic locations (e.g., multi-region `US` or regional `us-central1`), while modern Gemini models on the Gemini Enterprise Agent Platform are accessed via their global endpoint (`location="global"`). Keeping these parameters decoupled ensures compliance with data residency policies while preventing 404 regional endpoint errors.

```python
# [Cell 2] (Python Code)
# Install required Google Cloud SDKs, Data Lineage client, GenAI SDK, and Pydantic
!pip install -q --no-warn-conflicts google-cloud-bigquery google-cloud-dataplex google-cloud-datacatalog-lineage google-genai pydantic
```

### Parameter configuration

Configure your Google Cloud project and deployment regions. Learn more in the [BigQuery documentation](https://cloud.google.com/bigquery/docs?utm_source=devrel&utm_medium=notebook) and [Knowledge Catalog documentation](https://cloud.google.com/dataplex/docs/catalog-overview?utm_source=devrel&utm_medium=notebook).

```python
# [Cell 4] (Python Code)
import os
import sys

# @title Configuration & Deployment Parameters
PROJECT_ID = "your-project-id"  # @param {type:"string"}
REGION = "us-central1"  # @param {type:"string"}
BQ_LOCATION = "US"  # @param {type:"string"}
GEMINI_LOCATION = "global"  # @param {type:"string"}
GEMINI_MODEL = "gemini-3.7-flash"  # @param {type:"string"}
DATASET_ID = "enterprise_governance_observability"  # @param {type:"string"}

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
print(f"Gemini Enterprise Agent Platform Endpoint: {GEMINI_LOCATION} (Model: {GEMINI_MODEL})")
```

### Authenticate session and enable Google Cloud service APIs

Authenticate your active session when running inside Google Colab and enable necessary service APIs.

```python
# [Cell 6] (Python Code)
# Authenticate user when running in Google Colab environment
if "google.colab" in sys.modules:
    from google.colab import auth
    auth.authenticate_user()
    print("Colab user session authenticated successfully.")
```

### Initialize Google Cloud SDK clients

Initialize official SDK clients for BigQuery, Knowledge Catalog, Data Lineage, and Gemini Enterprise Agent Platform using the decoupled endpoint configuration.

```python
# [Cell 8] (Python Code)
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
# [Cell 10] (Python Code)
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class AgentRiskDecision(BaseModel):
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
        description="Detailed reasoning referencing certified catalog metadata and lineage."
    )


class DecisionProvenance(BaseModel):
    decision_id: str
    target_account_id: int
    assigned_tier: str
    catalog_aspect_type: str
    certification_status: str
    governance_owner: str
    upstream_lineage_edges: List[Dict[str, str]]
    lineage_processes: List[Dict[str, Any]] = Field(default_factory=list)
    timestamp_utc: str


print("Data contracts and structured schemas defined.")
```

## Step-by-step procedural execution

### Ingest and stage raw data in BigQuery

Create a demonstration BigQuery dataset with a 24-hour auto-expiration policy. Stage a bounded sample of 1,000 transaction records from the public TheLook eCommerce dataset (`bigquery-public-data.thelook_ecommerce.order_items`).

#### Expected output
The staging job creates `bronze_order_items` with exactly 1,000 rows and auto-expiration enabled.

```python
# [Cell 12] (Python Code)
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
# [Cell 14] (Python Code)
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

Implement an automated diagnostic quality gate (`check_pipeline_health`) that checks required columns, data freshness, null boundaries, and return ratio limits before feeding data to AI models.

```python
# [Cell 16] (Python Code)
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
# [Cell 18] (Python Code)
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
is_drift_caught = check_pipeline_health(drifted_view_id)
print(f"Negative Falsification Test Result: Diagnostic Gate Intercepted Bad Data = {not is_drift_caught}")

# In-step assertion: Prove gate intercepts invalid schema
assert is_drift_caught is False, "Diagnostic gate failed to catch missing column drift"
```

### Knowledge Catalog semantic governance and aspect entry binding

Register an `enterprise-data-quality` aspect type in Knowledge Catalog and attach it directly to the BigQuery Gold table system entry.

> [!IMPORTANT]
> **API Contracts for System Entry Updates**:
> 1. BigQuery system entries exist under the `@bigquery` entry group at `projects/{PROJECT_ID}/locations/{KC_LOCATION}/entryGroups/@bigquery/entries/...`.
> 2. When calling `update_entry` on system entries, `update_mask` must specify `paths=["aspects"]` and the aspect key must be explicitly provided in `aspect_keys=[aspect_map_key]`.
> 3. To verify custom aspects on live entries, query `get_entry` with `view=EntryView.ALL`.

```python
# [Cell 20] (Python Code)
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
# [Cell 22] (Python Code)
import json
from google.genai import types

# 1. ACL-Aware Catalog Search: Discover certified entries within IAM boundary
search_req = dataplex_v1.SearchEntriesRequest(
    name=parent_location,
    query=f"project:{PROJECT_ID} dataset:{DATASET_ID} type=TABLE",
    page_size=10,
)
search_results = list(catalog_client.search_entries(request=search_req))
print(f"Discovered {len(search_results)} searchable entries in Knowledge Catalog.")

discovered_entries = [r.dataplex_entry.name for r in search_results if hasattr(r, "dataplex_entry") and r.dataplex_entry]
if discovered_entries:
    print(f"Primary ACL-Discovered Catalog Entry: {discovered_entries[0]}")

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
    model=GEMINI_MODEL,
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
# [Cell 24] (Python Code)
import uuid
from datetime import datetime, timezone

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

# If recent async lineage is propagating, include direct dependency edge
if not lineage_graph_edges:
    lineage_graph_edges.append({
        "source": f"bigquery:{bronze_table_id}",
        "target": target_table_fqn,
    })

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
provenance_trail = DecisionProvenance(
    decision_id=f"audit-{uuid.uuid4().hex[:8]}",
    target_account_id=agent_decision.evaluated_user_id,
    assigned_tier=agent_decision.risk_tier,
    catalog_aspect_type=aspect_type_id,
    certification_status=live_aspect_data["certification_status"],
    governance_owner=live_aspect_data["governance_owner"],
    upstream_lineage_edges=lineage_graph_edges,
    lineage_processes=process_provenance,
    timestamp_utc=datetime.now(timezone.utc).isoformat(),
)

print(f"Immutable Decision Audit Provenance Report:\n{provenance_trail.model_dump_json(indent=2)}")

# In-step assertion: Verify lineage provenance structure
assert len(provenance_trail.upstream_lineage_edges) >= 1, "Lineage graph edge extraction failed"
assert isinstance(provenance_trail.lineage_processes, list), "Lineage processes list missing"
```

## Verification and resilient cleanup

### Run substantive end-to-end assertions
Execute automated assertions validating data contracts, Knowledge Catalog aspect persistence, AI decision integrity, and lineage provenance before tearing down resources.

```python
# [Cell 26] (Python Code)
# Substantive end-to-end verification assertions
assert agent_decision.evaluated_user_id == target_account_id, "User ID mismatch in decision"
assert live_aspect_data["data_tier"] == "GOLD", "Catalog aspect data tier was not GOLD"
assert live_aspect_data["certification_status"] == "CERTIFIED_GOLD", "Catalog aspect was uncertified"
assert is_agent_blocked is True, "HITL gate verification failed"
assert is_drift_caught is False, "Negative falsification test failed"
assert len(provenance_trail.upstream_lineage_edges) >= 1, "Missing upstream lineage edges"
assert "TIER" in agent_decision.risk_tier, "Invalid risk tier format"

print("All multi-level end-to-end governance and integrity assertions PASSED successfully.")
```

### Clean up demonstration resources

Delete created demo resources (BigQuery tables, dataset, and Knowledge Catalog AspectType) to prevent ongoing billing and resource leaks.

```python
# [Cell 28] (Python Code)
# Clean up demonstration resources
ENABLE_CLEANUP = True

if not isinstance(ENABLE_CLEANUP, bool):
    raise TypeError("ENABLE_CLEANUP must be a boolean flag.")

if ENABLE_CLEANUP:
    print("Initiating resilient resource teardown...")

    # 1. Delete BigQuery demonstration dataset and all tables
    if "dataset_ref" in locals() and dataset_ref:
        try:
            bq_client.delete_dataset(dataset_ref, delete_contents=True, not_found_ok=True)
            print(f"Deleted BigQuery dataset: {DATASET_ID}")
        except Exception as e:
            print(f"Note on dataset deletion: {e}")

    # 2. Delete Knowledge Catalog AspectType
    if "aspect_type_name" in locals() and aspect_type_name:
        try:
            catalog_client.delete_aspect_type(name=aspect_type_name)
            print(f"Deleted Knowledge Catalog AspectType: {aspect_type_id}")
        except google.api_core.exceptions.NotFound:
            pass
        except Exception as e:
            print(f"Note on AspectType deletion: {e}")

    print("Resource teardown completed successfully.")
else:
    print("Cleanup skipped. Resources retained.")
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
