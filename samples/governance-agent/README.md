# Governance on Auto-pilot: Agentic Data Governance with Knowledge Catalog

This project demonstrates an agentic data governance solution using Google Cloud Knowledge Catalog. It showcases how to automate metadata management - propagate descriptions, glossary terms, policy tags etc. using **column level lineage** and leveraging Knowledge Catalog **Dataset Insights** capabilities. This is only a demonstration and is not part of official product, please review everything before using it for your environments and use-cases.

---

## 🌟 Key Features

*   **Estate Dashboard**: Scan BigQuery datasets to identify metadata gaps (missing descriptions).
*   **Recursive Description Propagation**: Automatically fetch descriptions from upstream sources, bridging multi-hop gaps.
*   **SQL-Based Logic Enrichment**: Extracts BigQuery SQL transformations to generate human-readable descriptions for computed columns.
*   **AI Business Glossary**: Maps technical columns to business terms using Vertex AI Semantic Similarity and **Unstructured Documents** (PDFs, TXT, MD).
*   **Prioritized Glossary Propagation**: Automatically propagates glossary terms across tables based on lineage, with strict verification thresholds to ensure accuracy (especially for 1-1 mappings).
*   **Native Knowledge Catalog Integration**: Persists glossary mappings as native `EntryLinks` visible in the Knowledge Catalog Schema tab.
*   **Unified UI & CLI**: Manage governance tasks via a Gradio-based web app or a headless CLI.
*   **Policy Tag Propagation**: Recommends and applies BigQuery policy tags via lineage, with support for "straight pull" detection and an integrated **Access Summary** (Readers & Data Policies).
*   **Data Trust Center (DQ)**: Derived trust scores for views and tables based on upstream Knowledge Catalog DQ/Profiling results and multi-hop lineage.
*   **Unstructured Document Processing**: Leverage PDFs, TXT, and Markdown files to influence column descriptions and policy tags using Gemini and RAG.
*   **Remediation Detection**: Automatically detects SQL transformations (e.g. `COALESCE`, `DISTINCT`) that improve data quality and applies "Trust Bonuses".
*   **Trust History Persistence**: Tracks 0.0-1.0 trust scores over time in BigQuery for trend analysis.
*   **CLL API Preview allowlisting required**: Please contact your Google Cloud account team to get access to CLL API

---

## 🛠 Setup & Installation

### Prerequisites
- Python 3.12+
- Google Cloud Project with billing enabled.
- APIs Enabled: `dataplex`, `bigquery`, `datacatalog`, `datalineage`, `aiplatform`.

### Installation
1.  **Clone & Navigate**:
    ```bash
    git clone <repo-url>
    cd governance-agent
    ```
2.  **Environment Setup**:
    ```bash
    # Install dependencies and sync virtual environment using uv
    uv sync --group dev
    ```
3.  **Authentication**:
    - **CLI/Dev**: Run `gcloud auth application-default login`.
    - **Gradio App**: Follow [OAUTH_SETUP_GUIDE.md](OAUTH_SETUP_GUIDE.md) to enable "Login with Google".

---

## 🚀 Usage Guide

### 1. Agentic Data Steward (UI)
The Gradio app provides a visual way to scan and apply metadata changes.
```bash
uv run python -m metadata_propagation.ui.gradio_app
```
- **Dashboard**: Run "Scan Dataset" to see health metrics.
- **Description Propagation**: Enter a table name to preview and apply lineage-based descriptions.
- **Glossary Propagation**: Enter a table name to preview and apply lineage-based glossary terms.
- **Policy Tag Propagation**: Propagate sensitive data tags across the lineage chain with automated transformation assessment.
- **Trust Center (DQ)**: Analyze derived trust scores for a view or table, showing upstream quality sources and remediation bonuses.
- **Settings**: Toggle OAuth/ADC modes for specific user actions.

### 2. 🐳 Deployment (Docker & Cloud Run)

For all deployment steps (local Docker and production Cloud Run), please refer to the comprehensive **[Deployment Guide](DEPLOYMENT_GUIDE.md)**.

Key sections covered:
* **[Local Docker Run](DEPLOYMENT_GUIDE.md#-local-docker-run)**: Building and testing the container locally.
* **[Automated Cloud Run Deployment (`deploy.sh`)](DEPLOYMENT_GUIDE.md#method-1-automated-script-deploysh--recommended)**: Automated Artifact Registry and Cloud Run setup.
* **[Direct Source Deploy (`gcloud run deploy --source`)](DEPLOYMENT_GUIDE.md#method-2-direct-source-deploy-gcloud-run-deploy---source)**: Build and deploy via Cloud Build without requiring Docker locally.
* **[Service Account IAM Roles](DEPLOYMENT_GUIDE.md#2-configure-cloud-run-service-account--iam-roles)**: Required permissions for BigQuery, Dataplex, Lineage, and Vertex AI.
* **[Authentication & OAuth Modes](DEPLOYMENT_GUIDE.md#-authentication-modes)**: Running with Service Account ADC (`BYPASS_OAUTH=true`) vs Google OAuth (see also [OAUTH_SETUP_GUIDE.md](OAUTH_SETUP_GUIDE.md)).
* **[Production Sizing & Troubleshooting](DEPLOYMENT_GUIDE.md#️-production-sizing--best-practices)**: Sizing recommendations and troubleshooting common deployment errors.

### 3. Steward CLI (Headless)
The CLI is designed for automation and quick scans.
```bash
# Scan a dataset for missing descriptions
uv run python -m metadata_propagation.steward_cli scan --dataset retail_syn_data

# Preview and apply description propagation to a table
uv run python -m metadata_propagation.steward_cli apply --dataset retail_syn_data --table transactions

# Preview and apply description propagation using Document Context (RAG)
uv run python -m metadata_propagation.steward_cli apply --dataset retail_syn_data --table transactions --document docs/design.pdf --context-mode rag

# Recommend glossary terms using Vertex AI Semantic Similarity
uv run python -m metadata_propagation.steward_cli glossary-recommend --dataset retail_syn_data --table transactions

# Recommend glossary terms using Document context
uv run python -m metadata_propagation.steward_cli glossary-recommend --dataset retail_syn_data --table transactions --document docs/glossary.pdf --context-mode rag

# Scan a dataset for existing policy tags
uv run python -m metadata_propagation.steward_cli policy-scan --dataset retail_syn_data

# Preview and apply policy tag propagation to a table (Lineage-based)
uv run python -m metadata_propagation.steward_cli policy-propagate --dataset retail_syn_data --table transactions --apply

# Preview and apply policy tag propagation using Document context
uv run python -m metadata_propagation.steward_cli policy-propagate --dataset retail_syn_data --table transactions --document docs/large_doc.pdf --context-mode rag

# Analyze and propagate trust/DQ scores for a view or table
uv run python -m metadata_propagation.steward_cli dq-propagate --dataset retail_syn_data --table customers

# NEW: End-to-end Knowledge Catalog AI Insight propagation (Trigger -> Extract -> Apply)
# This handles the full scan, wait, and metadata update in one go. Supports legacy alias `dataplex-propagate`.
uv run python -m metadata_propagation.steward_cli knowledge-propagate --dataset retail_syn_data --table transactions --apply
```

## 📄 Unstructured Document Processing
The tool can leverage unstructured documents (PDFs, TXT, MD) to influence data governance metadata when lineage is missing or to supplement it.

### Supported Components
*   **Column Descriptions**: Extracts business meanings and definitions for columns. Enforces strict grounding to avoid hallucinations.
*   **Policy Tags (PII)**: Extracts explicit sensitivity labels (like `PII: Y`) from documents and maps them to allowed policy tags in your project. No inference or guessing.
*   **Business Glossary Terms**: Maps columns to a controlled list of business terms based on explicit mentions in documents. Enforces strict grounding.

### Document Context Modes
When using the `--document` flag with the `apply`, `policy-propagate`, or `glossary-recommend` commands, you can specify a `--context-mode` to choose how the document is processed:

*   **`direct` (Context Injection)**: Reads the full text of the document(s) and appends it directly to the Gemini prompt for each column. Best for small documents.
    ```bash
    uv run python -m metadata_propagation.steward_cli apply --dataset retail_syn_data --table transactions --document docs/small_doc.txt --context-mode direct
    ```
*   **`rag` (In-Memory RAG)**: Chunks the document, generates embeddings, and retrieves the most relevant snippets for each column. Best for large documents to save tokens and improve focus.
    ```bash
    uv run python -m metadata_propagation.steward_cli apply --dataset retail_syn_data --table transactions --document docs/large_doc.pdf --context-mode rag
    ```
    > 💡 *Note: Vector embeddings are generated remotely using Vertex AI's `text-embedding-004` model and stored locally in-memory for fast similarity search.*
*   **`datastore` (Managed DataStore)**: Queries a pre-existing Vertex AI Search DataStore. Best for enterprise setups with large document repositories.
    ```bash
    uv run python -m metadata_propagation.steward_cli apply --dataset retail_syn_data --table transactions --context-mode datastore --datastore-id my-datastore-id
    ```

### 3. Data Integration Scripts
- **Generate Data**: `uv run python -m metadata_propagation.data_generation.generate_data` (Creates tables + lineage).
- **Run Profiling & DQ**: `uv run python -m metadata_propagation.data_generation.run_dq_scans` (Creates and runs Data Profile and Quality scans, natively published to BigQuery).
- **Unified Insights**: `uv run python -m metadata_propagation.dataplex_integration.insights_connector` (Triggers, waits and extracts documentation results).

---

## ⚙️ Glossary Cache Configuration

In enterprise governance workflows, stewards often scan read-only production datasets (where they lack `bigquery.dataEditor` permissions). To optimize glossary mapping recommendations, the steward needs a cache. The system supports redirecting the business glossary embeddings cache to a dedicated writable dataset:

### 1. Web UI (Gradio)
Open the **Global Environment Settings** accordion at the top of the dashboard:
- **Glossary Cache Dataset ID**: The dataset where you want the `glossary_embeddings_cache` table to be created (e.g., a separate sandbox or metadata dataset).
- **Glossary Cache Table ID**: Custom table name for storing cached embeddings (defaults to `glossary_embeddings_cache`).

### 2. CLI Flags
You can pass the cache location explicitly as command line arguments to any command:
```bash
uv run python -m metadata_propagation.steward_cli glossary-recommend \
  --dataset prod_readonly_dataset \
  --table transactions \
  --cache-dataset metadata_sandbox_dataset \
  --cache-table my_glossary_cache
```

### 3. Environment Variables
You can also set these values in a `.env` file or in your shell:
* `GLOSSARY_CACHE_DATASET_ID`: Redirects the cache table to a separate BigQuery dataset.
* `GLOSSARY_CACHE_TABLE_ID`: Custom name for the BigQuery cache table.

> 💡 *Note: If BigQuery cache initialization fails due to write permissions, the plugin automatically falls back to a local JSON file cache (`scratch/glossary_embeddings_cache.json`) transparently, ensuring zero disruption to the user experience.*

---

## 🧩 Project Modules

| Module | Location | Description |
| :--- | :--- | :--- |
| **Glossary Plugin** | `agent/plugins/glossary_plugin.py` | Handles Business Glossary mapping using Vertex AI. |
| **Lineage Plugin** | `agent/plugins/lineage_plugin.py` | Orchestrates description propagation via Lineage API. |
| **Policy Tag Plugin** | `agent/plugins/policy_tag_plugin.py` | Recommends and applies Policy Tags based on lineage and SQL analysis. |
| **Similarity Engine** | `agent/plugins/similarity_engine.py` | AI logic for scoring lexical and semantic matches. |
| **DQ Plugin** | `agent/plugins/dq_plugin.py` | Interfaces with Knowledge Catalog DQ/Profiling result jobs with BQ fallbacks. |
| **DQ Propagation** | `dataplex_integration/dq_propagation.py` | Recursive DQ scoring and remediation detection logic. |
| **Traverser** | `dataplex_integration/lineage_propagation.py` | Low-level Graph API logic for traversing dependencies. |
| **Enricher** | `dataplex_integration/lineage_propagation.py` | Context-aware SQL transformation analyzer. |

---

## 💡 Workflow Example

1.  **Initialize**: Generate synthetic data and lineage relationships.
2.  **Enrich & Propagate**: Run the unified `knowledge-propagate` command to trigger AI scans and sync metadata.
4.  **Tag**: Use the **Glossary Plugin** to map technical columns to the Business Glossary for Knowledge Catalog UI visibility.
5.  **Secure**: Use the **Policy Tag Propagation** plugin to sync sensitive data tags and verify access summary (Readers/Masking Rules).
6.  **Verify**: Check the **BigQuery Console** (Schema -> Policy Tags) and **Knowledge Catalog Schema** (Business Terms).
