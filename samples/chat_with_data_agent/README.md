# Chat with Data Agent

The **Chat with Data Agent** is an enterprise Agentic AI assistant built on the Google Agent Development Kit (ADK). It discovers data assets by invoking the `knowledge_catalog_discovery_agent` directly as an Agent Tool (`AgentTool`) and interacts with BigQuery and Dataplex using OneMCP over `StreamableHTTPConnectionParams`.

## Architecture & Integration
- **Agent Tool Delegation (`AgentTool`)**: Exposes the `knowledge_catalog_discovery_agent` directly as a tool rather than a sub-agent transfer, allowing seamless discovery within the current conversation turn.
- **BigQuery OneMCP Integration**: Employs BigQuery OneMCP tools to run queries, list datasets, and inspect table schemas using Application Default Credentials (ADC).
- **Dataplex OneMCP Integration**: Incorporates Dataplex management tools via OneMCP using an inline lambda exclusion filter (`tool_filter`) to omit search tools (`search_entries`), avoiding overlap with the dedicated discovery agent tool.

## Deployment Instructions

The agent can be managed and deployed on Vertex AI Agent Engine (Reasoning Engines) using the `deploy.py` script. The script uses environment variables for configuration.

### Service Account & IAM Permissions

When deployed on Vertex AI Reasoning Engines, the runtime container executes under a designated service account. You can specify this account by exporting the `SERVICE_ACCOUNT` environment variable before deploying (if omitted, Vertex AI defaults to the Compute Engine default service account).

#### Required IAM Roles

To successfully discover assets in Knowledge Catalog and execute BigQuery queries, the target service account must be granted the following roles:
*   **Dataplex Viewer** (`roles/dataplex.viewer`): On the primary project and any remote data projects (e.g. prober datasets or data mesh targets) containing discovery entries.
*   **Service Usage Consumer** (`roles/serviceusage.serviceUsageConsumer`): On the billing project to authorize passing `x-goog-user-project` quota attribution headers.
*   **BigQuery Data Viewer / Job User** (`roles/bigquery.dataViewer`, `roles/bigquery.jobUser`): For executing analytical SQL queries against target datasets.
*   **Storage Object Admin** (`roles/storage.objectAdmin`): On the Cloud Storage staging bucket.

### Observability & Telemetry

The runtime container is automatically instrumented with OpenTelemetry tracing and Cloud Logging correlation. When deploying or updating via `deploy.py`, the following environment variables are explicitly persisted to the Vertex AI container:
*   `OTEL_TRACES_EXPORTER`: Exporter backend for OpenTelemetry spans (defaults to `gcp_cloud_trace`).
*   `OTEL_LOGS_EXPORTER`: Exporter backend for structured logs (defaults to `gcp_cloud_logging`).
*   `OTEL_PYTHON_LOG_CORRELATION`: Automatically injects `trace_id` and `span_id` into application logs (defaults to `true`).

### Prerequisites

Create and activate a Python virtual environment, then install required dependencies:

```bash
# Create virtual environment
python3 -m venv .venv

# Activate virtual environment
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 1. Creating a New Deployment

To deploy a new instance of the Chat with Data Agent:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="us-central1"
export STAGING_BUCKET="gs://your-staging-bucket"  # Optional; defaults to gs://{project_id}-adk-staging
export DEPLOY_ACTION="create"

python3 deploy.py
```

### 2. Updating an Existing Deployment

To update an existing agent engine runtime (e.g. after updating instructions or authentication logic):

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="us-central1"
export DEPLOY_ACTION="update"
export RESOURCE_ID="projects/your-project-id/locations/us-central1/reasoningEngines/your-engine-id"

python3 deploy.py
```

### 3. Deleting a Deployment

To remove an agent engine resource:

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="us-central1"
export DEPLOY_ACTION="delete"
export RESOURCE_ID="projects/your-project-id/locations/us-central1/reasoningEngines/your-engine-id"

python3 deploy.py
```
