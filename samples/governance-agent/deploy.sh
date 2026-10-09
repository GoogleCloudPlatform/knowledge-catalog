#!/bin/bash

# Stop on first error
set -e

# Configuration (can be overridden via environment variables)
PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}
SERVICE_NAME=${SERVICE_NAME:-"governance-agent"}
REGION=${REGION:-"europe-west1"}
REPO_NAME=${REPO_NAME:-"governance-repo"}
IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:latest"

if [ -z "$PROJECT_ID" ]; then
  echo "❌ Error: Google Cloud Project ID is not set. Run 'gcloud config set project <PROJECT_ID>' or export PROJECT_ID=<PROJECT_ID>."
  exit 1
fi

echo "🚀 Starting deployment of ${SERVICE_NAME} to ${REGION} in project ${PROJECT_ID}..."

# 1. Ensure Artifact Registry repository exists
echo "🔍 Checking for Artifact Registry repository '${REPO_NAME}' in ${REGION}..."
if ! gcloud artifacts repositories describe "${REPO_NAME}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "🆕 Creating Artifact Registry repository '${REPO_NAME}' in ${REGION}..."
  gcloud artifacts repositories create "${REPO_NAME}" \
    --project="${PROJECT_ID}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Repository for Governance Agent images"
fi

# 2. Build and push image (using local Docker if available, otherwise Cloud Build)
if command -v docker &>/dev/null && docker info &>/dev/null; then
  echo "🔐 Configuring Docker credential helper for Artifact Registry..."
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

  echo "📦 Building Docker image for linux/amd64..."
  docker build --platform linux/amd64 -t "${IMAGE_NAME}" .

  echo "📤 Pushing image to Artifact Registry..."
  docker push "${IMAGE_NAME}"
else
  echo "ℹ️  Local Docker daemon not running or not found. Using Google Cloud Build..."
  gcloud builds submit --project="${PROJECT_ID}" --tag="${IMAGE_NAME}" .
fi

# 3. Extract environment variables from .env if present
ENV_VARS_FLAG=""
if [ -f .env ]; then
  echo "📝 Extracting environment variables from .env..."
  ENV_VARS=$(grep -v '^#' .env | grep -v '^\s*$' | while read -r line; do
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      echo "$line"
    fi
  done | tr '\n' ',' | sed 's/,$//')

  if [ -n "$ENV_VARS" ]; then
    ENV_VARS_FLAG="--set-env-vars=${ENV_VARS}"
  fi
fi

# The app refuses to start without an explicit auth mode (no silent ADC fallback).
if ! { [[ ",${ENV_VARS}," =~ ,GOOGLE_CLIENT_ID=[^,]+, ]] && [[ ",${ENV_VARS}," =~ ,GOOGLE_CLIENT_SECRET=[^,]+, ]]; } \
   && [[ ! ",${ENV_VARS}," =~ ,BYPASS_OAUTH=true, ]]; then
  echo "❌ Error: no authentication mode configured in .env."
  echo "   Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (plus SESSION_SECRET_KEY) for Google OAuth,"
  echo "   or BYPASS_OAUTH=true for Service Account (ADC) mode behind IAP. See DEPLOYMENT_GUIDE.md."
  exit 1
fi

# 4. Deploy to Cloud Run
echo "☸️ Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --image="${IMAGE_NAME}" \
  --platform=managed \
  --region="${REGION}" \
  --port=8080 \
  --memory=2Gi \
  --cpu=2 \
  ${ENV_VARS_FLAG} \
  --allow-unauthenticated

echo "✅ Deployment successful!"
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)')
echo "🔗 App is available at: ${SERVICE_URL}"
echo ""
echo "----------------------------------------------------------------------"
echo "📌 NEXT STEPS & POST-DEPLOYMENT CONFIGURATION:"
echo "----------------------------------------------------------------------"
echo "Option A: Using Google OAuth ('Login with Google'):"
echo "  1. Add '${SERVICE_URL}/google_callback' to Authorized Redirect URIs"
echo "     in GCP Console -> APIs & Services -> Credentials -> OAuth Client."
echo "  2. Update the redirect URI on Cloud Run:"
echo "     gcloud run services update ${SERVICE_NAME} --region ${REGION} \\"
echo "       --update-env-vars GOOGLE_REDIRECT_URI=${SERVICE_URL}/google_callback"
echo ""
echo "Option B: Running with Service Account ADC (Bypass OAuth Login):"
echo "  If you prefer using the Cloud Run Service Account directly (e.g. behind IAP):"
echo "     gcloud run services update ${SERVICE_NAME} --region ${REGION} \\"
echo "       --update-env-vars BYPASS_OAUTH=true"
echo "----------------------------------------------------------------------"
