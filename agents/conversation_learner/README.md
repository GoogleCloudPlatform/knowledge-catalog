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
- **Trajectory Analysis**: Uses Cloud Logging to fetch recent conversational trajectories. For each conversation, the messages from every inference log entry are merged (deduplicated, in chronological order) into one transcript — earlier entries backfill any later entry whose `gen_ai.*.messages` label exceeded Cloud Logging's 64 KiB limit and was truncated.
- **Per-conversation LLM-as-a-judge**: Each conversation is judged **independently and in parallel** (a direct Vertex `generate_content` call per conversation), extracting detection signals, gaps, and `ContextEnrichmentProposal` records. This bounds each judge's context for more consistent analysis and scales to many conversations, instead of analyzing every conversation in a single pass.
- **Cross-conversation dedup**: A lightweight aggregation pass deduplicates proposals across conversations (same asset + gap type), keeping the highest-confidence instance, before saving to `proposal.json`.

## Running Locally

```bash
export GOOGLE_CLOUD_PROJECT="your-project-id"
export GOOGLE_CLOUD_LOCATION="us-central1"
export GOOGLE_GENAI_USE_VERTEXAI=True

# Authenticate so the Cloud Logging client can read trajectories
gcloud auth application-default login

# From the conversation_learner directory
adk run .
```

Example prompt:
```
generate learnings for projects/<project-number>/locations/us-central1/reasoningEngines/<engine-id> in the past 7 days
```

The agent will print the number of log entries retrieved, the unique conversation IDs found, and save enrichment proposals to `proposal.json`.

To attach a deterministic, run-stable `id` to each saved proposal, ask for them — e.g. append `with proposal ids` to your prompt. The id is derived from the proposal's identity (asset type + asset name + gap type), so the same gap on the same asset yields the same id across runs. The (volatile) proposed wording is ignored, and the asset name is canonicalized so an optional `project.` prefix doesn't produce two different ids.

> **Note on Observability**: The agent retrieves conversations from Cloud Logging using OpenTelemetry trace logs (`gen_ai.client.inference.operation.details`). These logs are only emitted for sessions that ran while **Observability was enabled** on the Reasoning Engine. Sessions started before Observability was activated will not appear.

## Reviewing proposals (human-in-the-loop)

`proposal.json` is a queue of *suggested* enrichments — a human reviews and approves them before the Enrichment Agent acts. A local Streamlit UI provides this step. It reads the JSON files directly (no cloud, no agent runtime needed), so its dependency is kept **separate** from `requirements.txt`:

```bash
# From the conversation_learner directory
pip install -r requirements-review.txt
streamlit run review_app.py
```

The UI lets you:
- Filter by status, gap type, detection signal, confidence, and asset name.
- Approve / reject each proposal, or **bulk-approve** all pending proposals above a confidence threshold.
- See live counts and an **Analytics** tab (by status / gap type / confidence band).
- **Export** the approved subset to `approved_proposals.json` — the hand-off the Enrichment Agent consumes.

State is fully local:
- Decisions are written to `reviews.json`, **keyed by each proposal's stable `id`** — so re-running the agent and regenerating `proposal.json` never clobbers your decisions.
- If `proposal.json` was generated without ids, the UI computes the same id on the fly (id logic is shared via `proposal_id.py`), so review still works.

> **Productionizing**: this demo keeps review state in local JSON. A hosted, multi-user deployment would move the lifecycle to a transactional store (e.g. Firestore or Cloud SQL) with audit fields (reviewer, timestamp) and RBAC, mirror it to BigQuery for dashboards/analytics, and add content-drift re-review. Out of scope here.

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
