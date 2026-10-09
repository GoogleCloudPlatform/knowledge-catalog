# Production Deployment Guide: Governance Agent on Cloud Run

This guide provides end-to-end, production-ready instructions for deploying the **Agentic Data Governance** application to **Google Cloud Run**.

---

## 🏗️ Architecture Overview

* **Application Framework**: Gradio web UI mounted on FastAPI and served with Uvicorn.
* **Runtime**: Containerized Python 3.11 environment running on Google Cloud Run (fully managed serverless).
* **Port Contract**: Automatically listens on `0.0.0.0` using the `$PORT` environment variable supplied by Cloud Run (default `8080`).
* **Authentication**: Supports either interactive user Google OAuth 2.0 or headless Service Account Application Default Credentials (ADC).

---

## 📋 Prerequisites

### 1. Enable Required GCP APIs
Run the following in your Google Cloud terminal:
```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  dataplex.googleapis.com \
  datacatalog.googleapis.com \
  datalineage.googleapis.com \
  bigquery.googleapis.com \
  aiplatform.googleapis.com
```

### 2. Configure Cloud Run Service Account & IAM Roles
Cloud Run services run under a dedicated runtime Service Account. In production, create a custom Service Account and assign the necessary least-privilege roles:

```bash
PROJECT_ID=$(gcloud config get-value project)
SA_NAME="governance-agent-sa"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# 1. Create the dedicated service account
gcloud iam service-accounts create ${SA_NAME} \
  --display-name="Governance Agent Cloud Run SA"

# 2. Grant necessary IAM roles
for ROLE in \
  roles/bigquery.dataEditor \
  roles/bigquery.jobUser \
  roles/dataplex.admin \
  roles/datalineage.viewer \
  roles/aiplatform.user; do
    gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="${ROLE}"
done
```

---

## 🐳 Local Docker Run

To run the containerized application locally on your workstation with your local GCP credentials mounted:

```bash
# 1. Build the Docker image
docker build -t governance-agent .

# 2. Run with local GCP credentials mounted
docker run -p 8080:8080 \
  --env-file .env \
  -v ~/.config/gcloud:/root/.config/gcloud \
  -e GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json \
  governance-agent
```
Once started, access the application at `http://localhost:8080`.

---

## 🚀 Cloud Run Deployment Methods

Choose one of the following methods to deploy the application to Google Cloud Run:

### Method 1: Automated Script (`deploy.sh`) — Recommended

The repository includes a self-contained deployment script that:
1. Validates and creates the Artifact Registry Docker repository if needed.
2. Builds and pushes the Docker container (uses local Docker if running; automatically falls back to Cloud Build if Docker daemon is not active).
3. Reads configuration from `.env` (if present).
4. Deploys the service to Cloud Run with recommended CPU, memory, and port settings.

```bash
# From the root of your knowledge-catalog clone
cd samples/governance-agent
chmod +x deploy.sh

# Optional: Override defaults via environment variables
# export REGION="europe-west1"
# export SERVICE_NAME="governance-agent"

./deploy.sh
```

---

### Method 2: Direct Source Deploy (`gcloud run deploy --source`)

If you don't have Docker installed locally, you can deploy directly from source using Google Cloud Build:

```bash
# From the root of your knowledge-catalog clone
cd samples/governance-agent

gcloud run deploy governance-agent \
  --source . \
  --region europe-west1 \
  --service-account "${SA_EMAIL}" \
  --port 8080 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300s \
  --allow-unauthenticated
```
*(Note: If prompted to create the `cloud-run-source-deploy` Artifact Registry repository, press `Y`).*

---

### Method 3: Manual Docker Build & Push

If you prefer building and pushing container images through your own CI/CD pipeline:

```bash
PROJECT_ID=$(gcloud config get-value project)
REGION="europe-west1"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/governance-repo/governance-agent:latest"

# 1. Ensure Artifact Registry repository exists
gcloud artifacts repositories create governance-repo \
  --repository-format=docker \
  --location=${REGION} \
  --description="Governance Agent Images" || true

# 2. Configure Docker authentication
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

# 3. Build container for linux/amd64 (required by Cloud Run)
docker build --platform linux/amd64 -t ${IMAGE_URI} .

# 4. Push image
docker push ${IMAGE_URI}

# 5. Deploy to Cloud Run
gcloud run deploy governance-agent \
  --image ${IMAGE_URI} \
  --region ${REGION} \
  --service-account "${SA_EMAIL}" \
  --port 8080 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300s \
  --allow-unauthenticated
```

---

## 🔐 Authentication Modes

After deployment, copy your Cloud Run Service URL (`https://<service-name>-<hash>.<region>.run.app`) and configure authentication:

> [!IMPORTANT]
> The app **refuses to start** unless one mode is configured: either `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (OAuth), or an explicit `BYPASS_OAUTH=true` (ADC). Missing OAuth settings no longer fall back silently to the Service Account. Put one of them in `.env` before running `deploy.sh`, or pass it via `--set-env-vars` on the first `gcloud run deploy`.

### Option A: Service Account ADC Mode (`BYPASS_OAUTH=true`) — Recommended for Internal/Enterprise
If your service runs inside a corporate perimeter (e.g., protected by Google Cloud Identity-Aware Proxy (IAP) or internal VPC ingress), you do not need individual users to log in through Google OAuth. All BigQuery and Dataplex operations will execute using the Cloud Run Service Account:

> [!CAUTION]
> In this mode the app performs **no user authentication**. Anyone who can reach the URL acts as the Service Account. Never combine `BYPASS_OAUTH=true` with a publicly reachable `--allow-unauthenticated` service. Put it behind IAP or internal ingress.

```bash
gcloud run services update governance-agent \
  --region europe-west1 \
  --update-env-vars BYPASS_OAUTH=true
```

### Option B: Interactive Google OAuth ("Login with Google")
If you want each user to sign in with their own Google Identity:

1. **OAuth Consent Screen**:
   - Go to **APIs & Services > OAuth consent screen**.
   - Set user type to **Internal** (recommended for Workspace domains).
   - Add scopes: `.../auth/bigquery`, `.../auth/cloud-platform`, `openid`, `email`, `profile`.

2. **Create OAuth 2.0 Web Client ID**:
   - Go to **APIs & Services > Credentials > Create Credentials > OAuth client ID**.
   - Application type: **Web application**.
   - **Authorized redirect URIs**: Add `https://<YOUR-CLOUD-RUN-URL>/google_callback`
   > [!IMPORTANT]
   > The redirect URI must end with `/google_callback`.

3. **Update Cloud Run Environment Variables** (`SESSION_SECRET_KEY` signs the session cookie; use a long random value so sessions work across instances and restarts):
   ```bash
   gcloud run services update governance-agent \
     --region europe-west1 \
     --update-env-vars \
GOOGLE_CLIENT_ID="<YOUR_CLIENT_ID>",\
GOOGLE_CLIENT_SECRET="<YOUR_CLIENT_SECRET>",\
GOOGLE_REDIRECT_URI="https://<YOUR-CLOUD-RUN-URL>/google_callback",\
SESSION_SECRET_KEY="<LONG_RANDOM_SECRET>"
   ```

   In this mode every action runs with the signed-in user's own OAuth token. Requests without a valid session are rejected, and the server never falls back to its Service Account.

---

## ⚙️ Production Sizing & Best Practices

| Setting | Recommended Value | Rationale |
| :--- | :--- | :--- |
| **CPU** | `2` | Handles concurrent RAG chunking and API requests. |
| **Memory** | `2Gi` or `4Gi` | In-memory RAG embeddings and large metadata schemas require adequate RAM. |
| **Request Timeout** | `300s` - `600s` | Recursive multi-hop lineage analysis across large datasets can take 1–3 minutes. |
| **Min Instances** | `1` *(optional)* | Keeps 1 instance warm to avoid container cold starts during business hours. |
| **Max Instances** | `10` | Caps autoscaling to avoid unexpected compute costs. |

To apply these production flags:
```bash
gcloud run services update governance-agent \
  --region europe-west1 \
  --min-instances 1 \
  --max-instances 10 \
  --timeout 600s
```

---

## 🛠️ Troubleshooting

### 1. `HTTPError 502: Bad Gateway` during `gcloud run deploy --source`
* **Cause**: Transient network error or temporary timeout when Cloud Build initializes the `cloud-run-source-deploy` Artifact Registry bucket for the first time.
* **Resolution**: Wait 30 seconds and retry, or use `./deploy.sh` which pre-creates the repository explicitly.

### 2. Container failed to start and listen on port
* **Cause**: Container tried to bind to a hardcoded port rather than Cloud Run's dynamic `$PORT`.
* **Resolution**: The provided [`Dockerfile`](Dockerfile) sets `ENV PORT=8080` and `EXPOSE 8080`. Cloud Run injects `$PORT` at runtime, which `metadata_propagation/ui/gradio_app.py` reads via `os.environ.get("PORT", 7860)`. Ensure `--port 8080` is passed during deployment.

### 3. `redirect_uri_mismatch` on OAuth Login
* **Cause**: The redirect URI registered in GCP Credentials does not exactly match the Cloud Run service URL.
* **Resolution**: Ensure `https://<YOUR-SERVICE-URL>/google_callback` is in the OAuth Client's Authorized Redirect URIs, and that `GOOGLE_REDIRECT_URI` environment variable is set to the exact same HTTPS URL.
