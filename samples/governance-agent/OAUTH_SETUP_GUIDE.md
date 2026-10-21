# Google Cloud OAuth & Authentication Guide

This guide explains how to configure authentication for the **Agentic Data Governance** application, both for local development and production deployments on Cloud Run.

---

## Architecture Overview

The application supports two primary authentication modes:
1. **User OAuth ("Login with Google")**: Authenticates end-users interactively using OAuth 2.0. The user's individual Google OAuth token is used to perform actions in BigQuery and Knowledge Catalog.
2. **ADC Mode (Application Default Credentials / Service Account)**: Uses the underlying environment credentials (e.g. `gcloud auth application-default login` locally, or the attached Google Cloud Service Account in Cloud Run). Can be enabled by setting `BYPASS_OAUTH=true`.

---

## Option 1: Configuring Google OAuth (User Login)

To enable "Login with Google", create an OAuth 2.0 Client ID in your Google Cloud Project.

### Step 1: Configure the OAuth Consent Screen
1. Navigate to [APIs & Services > OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) in the Google Cloud Console.
2. Choose **User Type**:
   - **Internal**: Recommended if deploying within an enterprise Google Workspace organization.
   - **External**: If testing with non-workspace Google accounts.
3. Click **Create** and configure **App Information**:
   - **App name**: e.g., `Agentic Governance Agent`
   - **User support email**: Your email / team email.
   - **Developer contact info**: Your email.
4. Click **Save and Continue**.
5. **Scopes**: Click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/bigquery`
   - `https://www.googleapis.com/auth/cloud-platform`
   - `openid`, `email`, `profile`
6. Click **Save and Continue**.

### Step 2: Create OAuth 2.0 Client ID
1. Navigate to [APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials).
2. Click **Create Credentials** > **OAuth client ID**.
3. Select **Application type**: **Web application**.
4. **Name**: e.g., `Governance Agent Web Client`.
5. **Authorized redirect URIs**:
   - For Local Dev: `http://localhost:7860/google_callback`
   - For Cloud Run: `https://<YOUR-CLOUD-RUN-SERVICE-URL>/google_callback`
   > [!IMPORTANT]
   > The callback path MUST be exactly `/google_callback`.
6. Click **Create** and copy the generated **Client ID** and **Client Secret**.

### Step 3: Configure Environment Variables
In your `.env` file (or Cloud Run environment variables):
```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:7860/google_callback   # Use your Cloud Run URL in production
```

---

## Option 2: Headless / Service Account (ADC) Mode

If you deploy behind Identity-Aware Proxy (IAP), an internal VPC, or prefer all actions to run under a unified service account identity, you can bypass interactive user OAuth:

1. Set `BYPASS_OAUTH=true` in your `.env` or Cloud Run environment:
   ```env
   BYPASS_OAUTH=true
   ```
2. The web interface will immediately bypass the Google login screen and execute all operations using the environment's Application Default Credentials (ADC).

---

## Cloud Run Service Account IAM Roles

When running on Cloud Run, ensure the Cloud Run runtime Service Account (e.g. `<service-name>-sa@<project-id>.iam.gserviceaccount.com` or Compute Engine default) has the following IAM roles:

| Role | Name | Purpose |
| :--- | :--- | :--- |
| `roles/bigquery.admin` or `roles/bigquery.dataEditor` | BigQuery Data Editor | Read/write table metadata and execute queries |
| `roles/bigquery.jobUser` | BigQuery Job User | Run BigQuery jobs and queries |
| `roles/dataplex.admin` or `roles/dataplex.editor` | Dataplex Administrator | Manage Knowledge Catalog aspects and glossary terms |
| `roles/datalineage.viewer` | Data Lineage Viewer | Read Column-Level Lineage (CLL) graph |
| `roles/aiplatform.user` | Vertex AI User | Run Vertex AI embeddings and Gemini models |

Grant roles via `gcloud`:
```bash
SA_EMAIL="<YOUR_SERVICE_ACCOUNT_EMAIL>"
PROJECT_ID="<YOUR_PROJECT_ID>"

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
