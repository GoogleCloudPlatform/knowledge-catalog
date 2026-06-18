"""Deployment script for ConversationLearner using environment variables."""

import logging
import os
import sys

from dotenv import load_dotenv
from google.api_core import exceptions as google_exceptions
from google.cloud import storage
import vertexai
from vertexai import agent_engines
from vertexai.preview.reasoning_engines import AdkApp

# Ensure current directory is in sys.path so agent can be imported
agent_dir = os.path.dirname(os.path.abspath(__file__))
if agent_dir not in sys.path:
    sys.path.insert(0, agent_dir)

from agent import root_agent

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def setup_staging_bucket(
    project_id: str, location: str, bucket_name: str
) -> str:
    """Checks if the staging bucket exists and creates it if not."""
    storage_client = storage.Client(project=project_id)
    try:
        bucket = storage_client.lookup_bucket(bucket_name)
        if bucket:
            logger.info("Staging bucket gs://%s already exists.", bucket_name)
        else:
            logger.info(
                "Staging bucket gs://%s not found. Creating...", bucket_name
            )
            new_bucket = storage_client.create_bucket(
                bucket_name, project=project_id, location=location
            )
            logger.info(
                "Successfully created staging bucket gs://%s in %s.",
                new_bucket.name,
                location,
            )
            # Enable uniform bucket-level access
            new_bucket.iam_configuration.uniform_bucket_level_access_enabled = True
            new_bucket.patch()
            logger.info(
                "Enabled uniform bucket-level access for gs://%s.",
                new_bucket.name,
            )
    except google_exceptions.Forbidden as e:
        logger.error(
            "Permission denied error for bucket gs://%s. "
            "Ensure the service account has 'Storage Admin' role. Error: %s",
            bucket_name,
            e,
        )
        raise
    except google_exceptions.Conflict as e:
        logger.warning(
            "Bucket gs://%s likely already exists. Error: %s",
            bucket_name,
            e,
        )
    except google_exceptions.ClientError as e:
        logger.error(
            "Failed to create or access bucket gs://%s. Error: %s",
            bucket_name,
            e,
        )
        raise

    return f"gs://{bucket_name}"


def create(service_account: str | None = None) -> None:
    """Creates and deploys ConversationLearner via AdkApp configuration."""
    agent_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(agent_dir)
    logger.info(
        "Deploying ConversationLearner via AdkApp on Vertex AI Agent Engine..."
    )

    # Read requirements from requirements.txt
    req_path = os.path.join(agent_dir, "requirements.txt")
    requirements = []
    if os.path.exists(req_path):
        with open(req_path, "r") as f:
            requirements = [
                line.strip()
                for line in f
                if line.strip() and not line.startswith("#")
            ]
    if not requirements:
        requirements = [
            "google-adk",
            "google-cloud-logging",
            "google-cloud-bigquery",
            "pydantic",
            "pydantic-settings",
            "google-api-core",
            "google-cloud-aiplatform",
            "python-dotenv",
        ]

    logger.info("Initializing AdkApp with root_agent...")
    app = AdkApp(agent=root_agent, enable_tracing=True)

    observability_env = {
        "OTEL_TRACES_EXPORTER": os.getenv("OTEL_TRACES_EXPORTER", "gcp_cloud_trace"),
        "OTEL_LOGS_EXPORTER": os.getenv("OTEL_LOGS_EXPORTER", "gcp_cloud_logging"),
        "OTEL_PYTHON_LOG_CORRELATION": os.getenv("OTEL_PYTHON_LOG_CORRELATION", "true"),
    }

    logger.info("Creating remote agent engine with service account %s...", service_account)
    remote_agent = agent_engines.create(
        app,
        display_name="ConversationLearner",
        description=(
            "Acts as an LLM-as-a-judge over conversational trajectories to detect friction "
            "and hallucination, generating metadata enrichment proposals."
        ),
        requirements=requirements,
        extra_packages=["."],
        env_vars=observability_env,
        service_account=service_account,
    )

    agent_name = (
        remote_agent.resource_name
        if hasattr(remote_agent, "resource_name")
        else (
            remote_agent.api_resource.name
            if hasattr(remote_agent, "api_resource")
            and hasattr(remote_agent.api_resource, "name")
            else str(remote_agent)
        )
    )
    logger.info("Successfully deployed agent: %s", agent_name)
    print(f"\nSuccessfully deployed agent: {agent_name}")


def update(resource_id: str, service_account: str | None = None) -> None:
    """Updates the specified agent via AdkApp configuration."""
    agent_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(agent_dir)
    logger.info(
        "Updating ConversationLearner %s via AdkApp on Vertex AI Agent"
        " Engine...",
        resource_id,
    )

    # Read requirements from requirements.txt
    req_path = os.path.join(agent_dir, "requirements.txt")
    requirements = []
    if os.path.exists(req_path):
        with open(req_path, "r") as f:
            requirements = [
                line.strip()
                for line in f
                if line.strip() and not line.startswith("#")
            ]
    if not requirements:
        requirements = [
            "google-adk",
            "google-cloud-logging",
            "google-cloud-bigquery",
            "pydantic",
            "pydantic-settings",
            "google-api-core",
            "google-cloud-aiplatform",
            "python-dotenv",
        ]

    logger.info("Initializing AdkApp with root_agent...")
    app = AdkApp(agent=root_agent, enable_tracing=True)

    observability_env = {
        "OTEL_TRACES_EXPORTER": os.getenv("OTEL_TRACES_EXPORTER", "gcp_cloud_trace"),
        "OTEL_LOGS_EXPORTER": os.getenv("OTEL_LOGS_EXPORTER", "gcp_cloud_logging"),
        "OTEL_PYTHON_LOG_CORRELATION": os.getenv("OTEL_PYTHON_LOG_CORRELATION", "true"),
    }

    logger.info("Updating remote agent engine with service account %s...", service_account)
    remote_agent = agent_engines.update(
        resource_id,
        agent_engine=app,
        requirements=requirements,
        extra_packages=["."],
        env_vars=observability_env,
        service_account=service_account,
    )

    agent_name = (
        remote_agent.resource_name
        if hasattr(remote_agent, "resource_name")
        else (
            remote_agent.api_resource.name
            if hasattr(remote_agent, "api_resource")
            and hasattr(remote_agent.api_resource, "name")
            else str(remote_agent)
        )
    )
    logger.info("Successfully updated agent: %s", agent_name)
    print(f"\nSuccessfully updated agent: {agent_name}")


def delete(resource_id: str) -> None:
    """Deletes the specified agent."""
    logger.info("Attempting to delete agent: %s", resource_id)
    try:
        remote_agent = agent_engines.get(resource_id)
        # Handle delete method differences across SDK versions
        if hasattr(remote_agent, "delete"):
            try:
                remote_agent.delete(force=True)
            except TypeError:
                remote_agent.delete()
        logger.info("Successfully deleted remote agent: %s", resource_id)
        print(f"\nSuccessfully deleted agent: {resource_id}")
    except google_exceptions.NotFound:
        logger.error("Agent with resource ID %s not found.", resource_id)
        print(f"\nAgent not found: {resource_id}")
    except Exception as e:
        logger.error(
            "An error occurred while deleting agent %s: %s", resource_id, e
        )
        print(f"\nError deleting agent {resource_id}: {e}")


def main() -> None:
    load_dotenv()

    project_id = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("PROJECT_ID")
    location = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

    default_bucket_name = f"{project_id}-adk-staging" if project_id else None
    bucket_name = os.getenv("GOOGLE_CLOUD_STORAGE_BUCKET") or os.getenv(
        "STAGING_BUCKET", default_bucket_name
    )
    service_account = os.getenv("SERVICE_ACCOUNT")

    action = os.getenv("DEPLOY_ACTION", "create").lower()
    resource_id = os.getenv("RESOURCE_ID")

    logger.info("Using PROJECT: %s", project_id)
    logger.info("Using LOCATION: %s", location)
    logger.info("Using BUCKET NAME: %s", bucket_name)
    logger.info("Using SERVICE ACCOUNT: %s", service_account)
    logger.info("Using ACTION: %s", action)

    if not project_id:
        print("\nError: Missing required GCP Project ID.")
        print("Set GOOGLE_CLOUD_PROJECT or PROJECT_ID environment variable.")
        return
    if not location:
        print("\nError: Missing required GCP Location.")
        return
    if not bucket_name and action in ("create", "update"):
        print(
            f"\nError: Missing required GCS Bucket Name for staging when"
            f" DEPLOY_ACTION={action}."
        )
        return
    if action in ("delete", "update") and not resource_id:
        print(
            f"\nError: RESOURCE_ID environment variable is required when"
            f" DEPLOY_ACTION={action}."
        )
        return

    try:
        staging_bucket_uri = None
        if action in ("create", "update"):
            staging_bucket_uri = setup_staging_bucket(
                project_id, location, bucket_name
            )

        vertexai.init(
            project=project_id,
            location=location,
            staging_bucket=staging_bucket_uri,
        )

        if action == "create":
            create(service_account)
        elif action == "update":
            update(resource_id, service_account)
        elif action == "delete":
            delete(resource_id)
        else:
            print(
                f"\nError: Unknown DEPLOY_ACTION '{action}'. Supported actions:"
                " create, update, delete."
            )



    except google_exceptions.Forbidden as e:
        print(f"\nPermission Error: {e}")
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")
        logger.exception("Unhandled exception in main:")


if __name__ == "__main__":
    main()
