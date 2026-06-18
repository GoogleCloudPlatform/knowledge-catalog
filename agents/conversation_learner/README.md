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

# ConversationLearner

**ConversationLearner** is an enterprise Agentic AI assistant built on the Google Agent Development Kit (ADK). It acts as an LLM-as-a-judge over conversational trajectories to detect friction and hallucination, generating metadata enrichment proposals.

## Architecture & Integration
- **Trajectory Analysis**: Uses Cloud Logging to fetch recent conversational trajectories.
- **LLM-as-a-judge**: Evaluates conversational turns to extract detection signals, gaps, and generate `ContextEnrichmentProposal` records.

## Running Locally

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="us-central1"
export GOOGLE_GENAI_USE_VERTEXAI=True

# From the conversation_learner directory
adk run .
```

Example prompt:
```
generate learnings for projects/<project-number>/locations/us-central1/reasoningEngines/<engine-id> in the past 7 days
```

The agent will print the number of log entries retrieved, the unique conversation IDs found, and save enrichment proposals to `proposal.json`.

> **Note on Observability**: The agent retrieves conversations from Cloud Logging using OpenTelemetry trace logs (`gen_ai.client.inference.operation.details`). These logs are only emitted for sessions that ran while **Observability was enabled** on the Reasoning Engine. Sessions started before Observability was activated will not appear.

## Running Tests

```bash
export GOOGLE_CLOUD_PROJECT=test-project

# From the agents/ directory
/path/to/venv/bin/python3 -m pytest conversation_learner/tests/ -v
```

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

To deploy a new instance of ConversationLearner:

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
