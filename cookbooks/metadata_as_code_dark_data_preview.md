> ℹ️ **Note**:
> **Internal Review Preview**: This Markdown document is generated exclusively for internal review inside Jetski/agent artifacts. It mirrors the exact cell sequence and structure of `metadata_as_code_dark_data.ipynb`. Do NOT publish or distribute this file externally.

<a href="https://colab.research.google.com/github/GoogleCloudPlatform/knowledge-catalog/blob/main/cookbooks/metadata_as_code_dark_data.ipynb?utm_source=devrel&utm_medium=colab_badge&utm_campaign=knowledge_catalog_dark_data" target="_parent"><img src="https://colab.research.google.com/assets/colab-badge.svg" alt="Open In Colab"/></a>

# Automated metadata-as-code for unstructured dark data with Knowledge Catalog and Gemini

This tutorial demonstrates how to build an automated, schema-enforced Metadata-as-Code pipeline on Google Cloud to govern unstructured dark data using [Knowledge Catalog](https://cloud.google.com/dataplex/docs/introduction?utm_source=devrel&utm_medium=notebook&utm_campaign=knowledge_catalog_dark_data) and [Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash?utm_source=devrel&utm_medium=notebook&utm_campaign=knowledge_catalog_dark_data).

---

## Executive overview

In modern enterprise data architectures, up to 80% of institutional knowledge is stored in unstructured files—such as technical PDF manuals, compliance agreements, research reports, and operational specs across [Cloud Storage](https://cloud.google.com/storage/docs?utm_source=devrel&utm_medium=notebook&utm_campaign=knowledge_catalog_dark_data) buckets. Lacking structured metadata and catalog discoverability, these files become isolated "dark data" silos invisible to analytics queries in [BigQuery](https://cloud.google.com/bigquery/docs?utm_source=devrel&utm_medium=notebook&utm_campaign=knowledge_catalog_dark_data), borderless [Apache Iceberg](https://iceberg.apache.org/) lakehouse tables, and autonomous AI agents.

This tutorial demonstrates how to implement a **Metadata-as-Code** pipeline to bring unstructured dark data under centralized enterprise governance. By combining multimodal extraction via Gemini through the [Google Gen AI SDK](https://github.com/googleapis/python-genai) with Knowledge Catalog custom Aspect Types, data teams can programmatically extract schema-enforced business metadata from unstructured files and publish it directly to the catalog. This integrates dark data into the borderless lakehouse ecosystem alongside BigQuery and Iceberg tables without data movement.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                UNSTRUCTURED DARK DATA GOVERNANCE PIPELINE                              │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  [UNSTRUCTURED ASSET LAYER]                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Cloud Storage Bucket / Source Repository                                                         │  │
│  │  • LUM-LIG-DES-8G8J_manual.pdf (Raw physical PDF user manual / product specification)            │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                  │                                                     │
│                                                  ▼ (Step 1: Download & Binary Ingestion)               │
│  [MULTIMODAL AI EXTRACTION LAYER]                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Gemini 3.7 Flash (google-genai SDK, location="global")                                           │  │
│  │  • Structured Pydantic Schema: DarkDataMetadataSchema                                            │  │
│  │  • Extracts: Document Title, Executive Summary, Domain Entities, Confidence Score                │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                  │                                                     │
│                                                  ▼ (Step 2: Schema Validation & Aspect Binding)   │
│  [ENTERPRISE GOVERNANCE & CATALOG LAYER]                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Knowledge Catalog (location="us-central1")                                                       │  │
│  │  • Entry Group: retail-dark-data (Domain Container Namespace)                                    │  │
│  │  • Entry Type : unstructured-document (Asset Classification Definition)                          │  │
│  │  • Aspect Type: dark-data-metadata (Strictly Typed Record Schema)                                │  │
│  │  • Live Entry : manual-lum-lig-des-8g8j (Bound Aspect via dot-separated map key)                 │  │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                  │                                                     │
│                                                  ▼ (Step 3: Unified Discovery & Consumption)          │
│  [DOWNSTREAM CONSUMERS & BORDERLESS LAKEHOUSE]                                                         │
│  ┌───────────────────────────────────────────────┐             ┌────────────────────────────────────┐  │
│  │ Enterprise Catalog Discovery                  │             │ Grounded AI Data Agents & RAG      │  │
│  │  • Knowledge Catalog search_entries query     │             │  • Reads live authoritative Aspect │  │
│  │  • Borderless lakehouse federation            │             │  • Zero in-memory mocking          │  │
│  └───────────────────────────────────────────────┘             └────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Target persona
* **Data platform engineers and architects**: Designing decentralized governance, cataloging, and metadata-as-code automation across the lakehouse.
* **Applied AI and analytics engineers**: Bringing uncataloged unstructured data into centralized catalogs for reliable AI agent grounding and enterprise search.

### Prerequisites
* A Google Cloud project with billing enabled.
* Required permissions: Knowledge Catalog Admin (`roles/dataplex.catalogAdmin`) and access to Gemini models.
* Python 3.10+ in a Jupyter or Google Cloud Colab environment.

### Estimated time
* **15 minutes**

### Learning objectives
By following this tutorial, you will:
1. **Provision and manage** Knowledge Catalog namespaces (`EntryGroup`, `EntryType`, `AspectType`) programmatically using the official Google Cloud SDK.
2. **Extract and structure** business metadata, executive summaries, and domain entities from raw PDF documents using Gemini and Pydantic validation.
3. **Bind and attach** custom Aspect Types to Knowledge Catalog Entries using dot-separated map keys.
4. **Discover and query** cataloged unstructured assets across the borderless lakehouse using Knowledge Catalog search.
5. **Clean up** provisioned cloud resources using reverse-order teardown.

---

## Environment setup and parameterized guardrails

In this section, you install the required Python client libraries and import necessary modules.

```python
# Install dependencies and import libraries
!pip install -q google-cloud-dataplex google-genai pydantic pandas

import os
import json
import urllib.request
import pandas as pd
from pydantic import BaseModel, Field
from google.auth import default
from google.cloud import dataplex_v1
from google.cloud.dataplex_v1.types import AspectType, Entry, Aspect, EntryGroup, EntryType
from google.api_core.exceptions import AlreadyExists, NotFound, ResourceExhausted
from google import genai
from google.genai import types
```

### Configure project parameters and governance constants

To adhere to the principle of strict domain decoupling:
* Catalog metadata and governance resources are provisioned in `REGION = "us-central1"`.
* Gemini models are accessed via the `global` AI endpoint (`GEMINI_LOCATION = "global"`).

> ℹ️ **Note**:
> **Data Residency & Endpoint Decoupling**: Gemini models use `GEMINI_LOCATION = "global"` because modern flagship models (`gemini-3.7-flash`) are deployed on global endpoints. Catalog governance resources are provisioned regionally in `REGION = "us-central1"`. If your enterprise compliance, sovereignty regulations, or VPC Service Controls require data processing within a specific region, verify regional model availability in Google Cloud documentation and configure `GEMINI_LOCATION` to your compliant region (such as `"us-central1"`).

```python
# Configure project parameters and governance constants
PROJECT_ID = "your-project-id"  # @param {type:"string"}
if not PROJECT_ID or PROJECT_ID == "your-project-id":
    raise ValueError("Missing required PROJECT_ID: Please enter a valid Google Cloud Project ID in the @param field.")

REGION = "us-central1"
# Set to "global" for latest flagship models. If data residency compliance requires regional processing, set to your region (e.g. "us-central1"):
GEMINI_LOCATION = "global"
MODEL_NAME = "gemini-3.7-flash"

ENTRY_GROUP_ID = "retail-dark-data"
ENTRY_TYPE_ID = "unstructured-document"
ASPECT_TYPE_ID = "dark-data-metadata"
TARGET_DOCUMENT_ID = "manual-lum-lig-des-8g8j"
SAMPLE_PDF_URL = "https://raw.githubusercontent.com/hyunuk/knowledge-catalog/cookbooks/cookbooks/manuals/LUM-LIG-DES-8G8J_manual.pdf"
LOCAL_PDF_PATH = "LUM-LIG-DES-8G8J_manual.pdf"

print(f"Project ID: {PROJECT_ID}")
print(f"Catalog Region: {REGION}")
print(f"Gemini Location: {GEMINI_LOCATION}")
print(f"Flagship Model: {MODEL_NAME}")
```

### Initialize Google Cloud SDK clients

In this step, you initialize `CatalogServiceClient` for metadata management and `genai.Client` with `vertexai=True` for model inference.

```python
# Initialize Google Cloud SDK clients
import sys

if "google.colab" in sys.modules:
    from google.colab import auth
    auth.authenticate_user()
    print("Colab user session authenticated successfully.")

catalog_client = dataplex_v1.CatalogServiceClient()
parent_location = f"projects/{PROJECT_ID}/locations/{REGION}"

genai_client = genai.Client(
    vertexai=True,
    project=PROJECT_ID,
    location=GEMINI_LOCATION,
)

print("SDK clients initialized successfully.")
print(f"Parent Location: {parent_location}")
```

---

## Data contracts and metadata schemas

Before extracting metadata from unstructured documents, you define a formal **metadata contract** using two complementary schemas:

1. **Pydantic Model (`DarkDataMetadataSchema`)**: Enforces strict typing (`str`, `float`) and descriptions that guide Gemini to output valid structured JSON.
2. **Knowledge Catalog Aspect Type Schema (`aspect_type_schema`)**: Defines the target storage record structure in Knowledge Catalog, guaranteeing schema conformance upon registration.

By synchronizing the AI output schema with the catalog aspect specification, you prevent silent schema drift and guarantee that every extracted document property maps cleanly to a catalog attribute.

```python
# Define metadata contract and Pydantic response schema
class DarkDataMetadataSchema(BaseModel):
    document_title: str = Field(description="Official document or product model name from manual")
    document_summary: str = Field(description="2-3 sentence executive summary of specifications and operating guidelines")
    extracted_entities: str = Field(description="Comma-separated list of key components, safety clauses, or model identifiers")
    confidence_score: float = Field(ge=0.0, le=1.0, description="AI extraction confidence metric between 0.0 and 1.0")

aspect_type_schema = {
    "name": "DarkDataMetadata",
    "type": "record",
    "record_fields": [
        {"name": "document_title", "type": "string", "index": 1, "annotations": {"description": "Document title or product name."}},
        {"name": "document_summary", "type": "string", "index": 2, "annotations": {"description": "2-3 sentence summary of specifications."}},
        {"name": "extracted_entities", "type": "string", "index": 3, "annotations": {"description": "Key components, safety clauses, or identifiers."}},
        {"name": "confidence_score", "type": "double", "index": 4, "annotations": {"description": "Extraction confidence metric between 0.0 and 1.0."}},
    ]
}

print("Metadata contracts defined successfully.")
```

---

## Step-by-step procedural execution

### Provision Knowledge Catalog namespaces

Knowledge Catalog organizes metadata using an object-oriented 3-tier hierarchy:

* **`EntryGroup` (`retail-dark-data`)**: A logical container for related assets within a domain.
* **`EntryType` (`unstructured-document`)**: An asset classification defining what category of resource is cataloged.
* **`AspectType` (`dark-data-metadata`)**: A reusable schema defining custom metadata attributes attached to entries.

In the following cell, you provision these namespaces using procedural `get_or_create` logic with authentic error handling.

```python
# Provision Knowledge Catalog namespaces and Aspect Types
entry_group_spec = EntryGroup(
    name=f"{parent_location}/entryGroups/{ENTRY_GROUP_ID}",
    description="Logical container for unstructured retail manual documents.",
    display_name="Retail Dark Data Documents",
)

def get_or_create_entry_group() -> EntryGroup:
    try:
        op = catalog_client.create_entry_group(
            parent=parent_location,
            entry_group_id=ENTRY_GROUP_ID,
            entry_group=entry_group_spec,
        )
        if hasattr(op, "result"):
            op.result()
        print(f"EntryGroup '{ENTRY_GROUP_ID}' provisioned successfully.")
        return catalog_client.get_entry_group(name=f"{parent_location}/entryGroups/{ENTRY_GROUP_ID}")
    except AlreadyExists:
        print(f"EntryGroup '{ENTRY_GROUP_ID}' already exists.")
        return catalog_client.get_entry_group(name=f"{parent_location}/entryGroups/{ENTRY_GROUP_ID}")

entry_type_spec = EntryType(
    name=f"{parent_location}/entryTypes/{ENTRY_TYPE_ID}",
    description="Custom Entry Type representing unstructured PDF documents.",
    display_name="Unstructured Document File",
)

def get_or_create_entry_type() -> EntryType:
    try:
        op = catalog_client.create_entry_type(
            parent=parent_location,
            entry_type_id=ENTRY_TYPE_ID,
            entry_type=entry_type_spec,
        )
        if hasattr(op, "result"):
            op.result()
        print(f"EntryType '{ENTRY_TYPE_ID}' provisioned successfully.")
        return catalog_client.get_entry_type(name=f"{parent_location}/entryTypes/{ENTRY_TYPE_ID}")
    except AlreadyExists:
        print(f"EntryType '{ENTRY_TYPE_ID}' already exists.")
        return catalog_client.get_entry_type(name=f"{parent_location}/entryTypes/{ENTRY_TYPE_ID}")

aspect_type_spec = AspectType(
    name=f"{parent_location}/aspectTypes/{ASPECT_TYPE_ID}",
    description="Aspect Type defining structured schema attributes extracted from manuals.",
    metadata_template=aspect_type_schema,
)

def get_or_create_aspect_type() -> AspectType:
    try:
        op = catalog_client.create_aspect_type(
            parent=parent_location,
            aspect_type_id=ASPECT_TYPE_ID,
            aspect_type=aspect_type_spec,
        )
        if hasattr(op, "result"):
            op.result()
        print(f"AspectType '{ASPECT_TYPE_ID}' provisioned successfully.")
        return catalog_client.get_aspect_type(name=f"{parent_location}/aspectTypes/{ASPECT_TYPE_ID}")
    except AlreadyExists:
        print(f"AspectType '{ASPECT_TYPE_ID}' already exists.")
        return catalog_client.get_aspect_type(name=f"{parent_location}/aspectTypes/{ASPECT_TYPE_ID}")

entry_group = get_or_create_entry_group()
entry_type = get_or_create_entry_type()
aspect_type = get_or_create_aspect_type()
```

### Ingest unstructured dark data and extract metadata with Gemini

In this step, you download a sample product manual PDF (`LUM-LIG-DES-8G8J_manual.pdf` — Contemporary Linen Desk Lamp User Manual) and pass its raw bytes directly to Gemini via the Google Gen AI SDK.

By supplying `response_schema=DarkDataMetadataSchema` in the `GenerateContentConfig`, the model produces guaranteed JSON adhering to your Pydantic contract.

```python
# Ingest unstructured PDF document and extract structured metadata with Gemini
print(f"Downloading sample PDF from {SAMPLE_PDF_URL}...")
urllib.request.urlretrieve(SAMPLE_PDF_URL, LOCAL_PDF_PATH)

with open(LOCAL_PDF_PATH, "rb") as f:
    pdf_bytes = f.read()
print(f"Downloaded PDF ({len(pdf_bytes)} bytes).")

prompt = """You are an expert technical data engineer analyzing an unstructured product manual PDF.
Extract the document title, a concise 2-3 sentence executive summary of specifications and operating guidelines,
key domain entities (components, safety rules, model identifiers), and an extraction confidence score between 0.0 and 1.0."""

print(f"Extracting structured metadata via {MODEL_NAME}...")
response = genai_client.models.generate_content(
    model=MODEL_NAME,
    contents=[
        types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf"),
        prompt,
    ],
    config=types.GenerateContentConfig(
        response_mime_type="application/json",
        response_schema=DarkDataMetadataSchema,
    ),
)

extracted_metadata = json.loads(response.text)

# In-step validation assertions
assert "document_title" in extracted_metadata, "Missing required 'document_title' in extracted metadata"
assert "confidence_score" in extracted_metadata, "Missing required 'confidence_score' in extracted metadata"
assert 0.0 <= extracted_metadata["confidence_score"] <= 1.0, "confidence_score out of valid [0.0, 1.0] range"

df_extracted = pd.DataFrame(list(extracted_metadata.items()), columns=["Attribute", "Extracted Value"])
print(df_extracted)
```

### Bind metadata aspect to Knowledge Catalog entry

With structured metadata extracted and validated, you create a Knowledge Catalog `Entry` representing the physical document and bind the extracted metadata as an `Aspect`.

### Key naming and retrieval rules

1. **Dot-Separated Aspect Map Key**: When creating an `Entry`, the `aspects` dictionary key must follow the format `{PROJECT_ID}.{REGION}.{ASPECT_TYPE_ID}`.
2. **Project Number Canonicalization Gotcha**: The Knowledge Catalog backend server canonicalizes alphanumeric Project IDs into numeric **Project Numbers** in aspect keys (e.g. `123456789012.us-central1.dark-data-metadata`). When retrieving aspects from a live entry, match keys using `.endswith(f".{REGION}.{ASPECT_TYPE_ID}")` to ensure code works reliably regardless of whether the backend returns a project ID or project number.
3. **Scoped Updates**: When updating existing entries, set `update_mask={"paths": ["aspects"]}` and `aspect_keys=[aspect_map_key]` to update only your custom aspect without mutating system-managed attributes.
4. **Retrieving Custom Aspects**: Always pass `view=dataplex_v1.EntryView.ALL` to `GetEntryRequest` to retrieve attached custom aspects.

```python
# Bind extracted metadata Aspect to Knowledge Catalog Entry
entry_group_name = f"{parent_location}/entryGroups/{ENTRY_GROUP_ID}"
entry_name = f"{entry_group_name}/entries/{TARGET_DOCUMENT_ID}"
aspect_map_key = f"{PROJECT_ID}.{REGION}.{ASPECT_TYPE_ID}"

target_entry = Entry(
    name=entry_name,
    entry_type=f"{parent_location}/entryTypes/{ENTRY_TYPE_ID}",
    aspects={
        aspect_map_key: Aspect(
            aspect_type=f"{parent_location}/aspectTypes/{ASPECT_TYPE_ID}",
            data=extracted_metadata,
        )
    },
)

def create_or_update_entry() -> Entry:
    try:
        op = catalog_client.create_entry(
            parent=entry_group_name,
            entry_id=TARGET_DOCUMENT_ID,
            entry=target_entry,
        )
        if hasattr(op, "result"):
            op.result()
        print(f"Created Entry with attached Aspect: {entry_name}")
        return catalog_client.get_entry(
            request=dataplex_v1.GetEntryRequest(name=entry_name, view=dataplex_v1.EntryView.ALL)
        )
    except AlreadyExists:
        print(f"Entry already exists. Updating Entry Aspect: {entry_name}")
        catalog_client.update_entry(
            request=dataplex_v1.UpdateEntryRequest(
                entry=target_entry,
                update_mask={"paths": ["aspects"]},
                aspect_keys=[aspect_map_key],
            )
        )
        print(f"Updated Entry Aspect: {entry_name}")
        return catalog_client.get_entry(
            request=dataplex_v1.GetEntryRequest(name=entry_name, view=dataplex_v1.EntryView.ALL)
        )

live_entry = create_or_update_entry()

# Resilient aspect retrieval matching aspect type suffix
live_aspect = next(
    (aspect for key, aspect in live_entry.aspects.items() if key.endswith(f".{REGION}.{ASPECT_TYPE_ID}")),
    None
)
assert live_aspect is not None, f"Failed to retrieve bound aspect ending in '.{REGION}.{ASPECT_TYPE_ID}'"

live_aspect_data = dict(live_aspect.data)
df_live = pd.DataFrame(list(live_aspect_data.items()), columns=["Attribute", "Authoritative Value"])
print(df_live)
```

### Discover and query cataloged assets across the lakehouse

Once bound, unstructured documents become first-class discoverable citizens alongside BigQuery tables and Apache Iceberg lakehouse datasets in a borderless lakehouse.

You execute a search query across Knowledge Catalog using `search_entries` to verify discovery across the enterprise governance plane.

```python
# Search and discover cataloged assets in Knowledge Catalog
import time

# Discover entries using entry group scoping
entry_group_name = f"{parent_location}/entryGroups/{ENTRY_GROUP_ID}"
search_query = f"entrygroup={entry_group_name}"
print(f"Searching Knowledge Catalog with scoped query: {search_query}...")

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
            )
        )
    )
    if search_results:
        break
    time.sleep(poll_interval)
    elapsed += poll_interval
    print(f"  Waiting for catalog search indexing... ({elapsed}/{max_wait_seconds}s)")

assert len(search_results) > 0, f"Expected at least 1 search result for {search_query} after {max_wait_seconds}s"

print(f"\n✓ Found {len(search_results)} catalog entry/entries for query {search_query}:\n")

# Retrieve and display full authoritative metadata for discovered assets
for result in search_results:
    entry_res_name = result.dataplex_entry.name
    print(f"Discovered Entry: {entry_res_name}")
    print(f"Entry Type      : {result.dataplex_entry.entry_type}")
    
    # Retrieve authoritative entry with ALL view to inspect custom aspect data
    full_entry = catalog_client.get_entry(
        request=dataplex_v1.GetEntryRequest(name=entry_res_name, view=dataplex_v1.EntryView.ALL)
    )
    for aspect_key, aspect_obj in full_entry.aspects.items():
        if aspect_key.endswith(f".{REGION}.{ASPECT_TYPE_ID}"):
            print(f"\n--- Authoritative Extracted Metadata ({ASPECT_TYPE_ID}) ---")
            df_aspect = pd.DataFrame(list(aspect_obj.data.items()), columns=["Field", "Catalog Value"])
            print(df_aspect.to_string(index=False))
```

---

## Verification and resilient cleanup

### Run substantive end-to-end assertions

Before teardown, you execute substantive assertions verifying that every created asset exists in Knowledge Catalog with correct data types, aspect bindings, and search discoverability.

```python
# Substantive end-to-end verification assertions
print("Executing substantive end-to-end verification assertions...")

# 1. Assert EntryGroup existence
retrieved_group = catalog_client.get_entry_group(name=f"{parent_location}/entryGroups/{ENTRY_GROUP_ID}")
assert retrieved_group is not None, f"EntryGroup '{ENTRY_GROUP_ID}' not found in Knowledge Catalog"

# 2. Assert EntryType existence
retrieved_type = catalog_client.get_entry_type(name=f"{parent_location}/entryTypes/{ENTRY_TYPE_ID}")
assert retrieved_type is not None, f"EntryType '{ENTRY_TYPE_ID}' not found in Knowledge Catalog"

# 3. Assert AspectType existence
retrieved_aspect_type = catalog_client.get_aspect_type(name=f"{parent_location}/aspectTypes/{ASPECT_TYPE_ID}")
assert retrieved_aspect_type is not None, f"AspectType '{ASPECT_TYPE_ID}' not found in Knowledge Catalog"

# 4. Assert live Entry and bound Aspect content fidelity
retrieved_entry = catalog_client.get_entry(
    request=dataplex_v1.GetEntryRequest(name=entry_name, view=dataplex_v1.EntryView.ALL)
)
assert retrieved_entry is not None, f"Entry '{entry_name}' not found in Knowledge Catalog"
bound_aspect = next(
    (aspect for key, aspect in retrieved_entry.aspects.items() if key.endswith(f".{REGION}.{ASPECT_TYPE_ID}")),
    None
)
assert bound_aspect is not None, f"Bound Aspect '{ASPECT_TYPE_ID}' missing from live Entry"
assert bound_aspect.data.get("document_title") == extracted_metadata["document_title"], "Title mismatch between extracted and bound aspect"

# 5. Assert catalog searchability
assert len(search_results) >= 1, "Catalog search results should contain at least 1 discovered entry"

print("All end-to-end verification assertions passed successfully!")
```

### Clean up resources

To avoid unnecessary cloud resource consumption, you delete all created entities in reverse dependency order (`Entry` → `EntryGroup` → `EntryType` → `AspectType`) and remove the local temporary PDF.

> 💡 **Tip**:
> Run the cleanup cell below when you are ready to permanently delete all demonstration resources.

```python
# Clean up resources in reverse dependency order (idempotent standalone execution)
import os
import time
from google.api_core.exceptions import NotFound, ResourceExhausted


print("Executing reverse-order resource teardown...")

if "catalog_client" in locals():
    parent_loc = (
        parent_location
        if "parent_location" in locals()
        else (
            f"projects/{PROJECT_ID}/locations/{REGION}"
            if "PROJECT_ID" in locals() and "REGION" in locals()
            else None
        )
    )

    # 1. Delete Entry
    if (
        parent_loc
        and "ENTRY_GROUP_ID" in locals()
        and "TARGET_DOCUMENT_ID" in locals()
    ):
        entry_res = f"{parent_loc}/entryGroups/{ENTRY_GROUP_ID}/entries/{TARGET_DOCUMENT_ID}"
        for _ in range(5):
            try:
                print(f"Deleting Entry: {entry_res}...")
                catalog_client.delete_entry(name=entry_res)
                print("Entry deleted successfully.")
                break
            except NotFound:
                print("Entry already deleted or not found.")
                break
            except ResourceExhausted:
                print("Rate limit reached. Waiting before retrying deletion...")
                time.sleep(10)

    # 2. Delete EntryGroup
    if parent_loc and "ENTRY_GROUP_ID" in locals():
        entry_group_res = f"{parent_loc}/entryGroups/{ENTRY_GROUP_ID}"
        for _ in range(5):
            try:
                print(f"Deleting EntryGroup: {entry_group_res}...")
                del_eg_op = catalog_client.delete_entry_group(name=entry_group_res)
                if hasattr(del_eg_op, "result"):
                    del_eg_op.result()
                print("EntryGroup deleted successfully.")
                break
            except NotFound:
                print("EntryGroup already deleted or not found.")
                break
            except ResourceExhausted:
                print("Rate limit reached. Waiting before retrying deletion...")
                time.sleep(10)

    # 3. Delete EntryType
    if parent_loc and "ENTRY_TYPE_ID" in locals():
        entry_type_res = f"{parent_loc}/entryTypes/{ENTRY_TYPE_ID}"
        for _ in range(5):
            try:
                print(f"Deleting EntryType: {entry_type_res}...")
                del_et_op = catalog_client.delete_entry_type(name=entry_type_res)
                if hasattr(del_et_op, "result"):
                    del_et_op.result()
                print("EntryType deleted successfully.")
                break
            except NotFound:
                print("EntryType already deleted or not found.")
                break
            except ResourceExhausted:
                print("Rate limit reached. Waiting before retrying deletion...")
                time.sleep(10)

    # 4. Delete AspectType
    if parent_loc and "ASPECT_TYPE_ID" in locals():
        aspect_type_res = f"{parent_loc}/aspectTypes/{ASPECT_TYPE_ID}"
        for _ in range(5):
            try:
                print(f"Deleting AspectType: {aspect_type_res}...")
                del_at_op = catalog_client.delete_aspect_type(name=aspect_type_res)
                if hasattr(del_at_op, "result"):
                    del_at_op.result()
                print("AspectType deleted successfully.")
                break
            except NotFound:
                print("AspectType already deleted or not found.")
                break
            except ResourceExhausted:
                print("Rate limit reached. Waiting before retrying deletion...")
                time.sleep(10)

# 5. Clean up local sample PDF
if "LOCAL_PDF_PATH" in locals() and os.path.exists(LOCAL_PDF_PATH):
    try:
        os.remove(LOCAL_PDF_PATH)
        print(f"Removed local sample PDF: {LOCAL_PDF_PATH}")
    except Exception as e:
        print(f"Local file cleanup note: {e}")

print("Teardown complete. Google Cloud environment cleanly reset.")
```

---

## Summary and production best practices

### Key takeaways

* **Schema-as-Code for Dark Data**: Knowledge Catalog custom Aspect Types allow physical unstructured documents to be governed with the same rigor as structured relational tables.
* **Deterministic AI Extraction**: Pairing Gemini with Pydantic response schemas eliminates hallucination risk and yields type-safe metadata.
* **Unified Lakehouse Discovery**: Registering unstructured assets in Knowledge Catalog makes files discoverable across the borderless lakehouse without moving raw data.

### Production deployment architecture

In an enterprise production environment, consider expanding this pattern into an automated event-driven ingestion pipeline:

```
[Cloud Storage: PDF Upload]
         │
         ▼ (google.cloud.storage.object.v1.finalized)
[Eventarc Trigger]
         │
         ▼
[Cloud Run / Cloud Function (Gemini + Pydantic Extraction)]
         │
         ▼
[Knowledge Catalog API (Entry + Aspect Binding)]
         │
         ▼
[Enterprise Governance & Downstream AI Agent Grounding]
```

* **Event-Driven Triggers**: Use [Eventarc](https://cloud.google.com/eventarc/docs?utm_source=devrel&utm_medium=notebook&utm_campaign=knowledge_catalog_dark_data) on Cloud Storage buckets (`google.cloud.storage.object.v1.finalized`) to trigger [Cloud Functions](https://cloud.google.com/functions/docs?utm_source=devrel&utm_medium=notebook&utm_campaign=knowledge_catalog_dark_data) or [Cloud Run](https://cloud.google.com/run/docs?utm_source=devrel&utm_medium=notebook&utm_campaign=knowledge_catalog_dark_data) services whenever a new PDF document is uploaded.
* **IAM Least Privilege**: Assign `roles/dataplex.entryGroupCreator` and `roles/dataplex.aspectTypeUser` specifically to the service account executing the ingestion worker.
* **Downstream RAG Integration**: Feed catalog metadata into grounded search systems to enhance relevance for conversational search and enterprise AI agents.

