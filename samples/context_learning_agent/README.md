<!--
 Copyright 2024 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->

# Context Learning Agent

The **Context Learning Agent** is an enterprise Agentic AI assistant built on the Google Agent Development Kit (ADK). It acts as an LLM-as-a-judge over conversational trajectories to detect friction and hallucination, generating metadata enrichment proposals.

## Architecture & Integration
- **Trajectory Analysis**: Uses Cloud Logging to fetch recent conversational trajectories.
- **LLM-as-a-judge**: Evaluates conversational turns to extract detection signals, gaps, and generate `ContextEnrichmentProposal` records.

## Deployment Instructions

The agent can be managed and deployed on Vertex AI Agent Engine (Reasoning Engines) using the `deploy.py` script. The script uses environment variables for configuration.

### Service Account & IAM Permissions

When deployed on Vertex AI Reasoning Engines, the runtime container executes under a designated service account. You can specify this account by exporting the `SERVICE_ACCOUNT` environment variable before deploying.

#### Required IAM Roles

To successfully fetch logs and execute agent logic, the target service account must be granted the following roles:
*   **Logging Viewer** (`roles/logging.viewer`): To read Cloud Logging entries for agent trajectories.
*   **Service Usage Consumer** (`roles/serviceusage.serviceUsageConsumer`): On the billing project.
*   **Storage Object Admin** (`roles/storage.objectAdmin`): On the Cloud Storage staging bucket.

### Observability & Telemetry

The runtime container is automatically instrumented with OpenTelemetry tracing and Cloud Logging correlation.

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

To deploy a new instance of the Context Learning Agent:

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
