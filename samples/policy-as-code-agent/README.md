# Policy-as-Code Agent

A generative AI-powered agent designed to automate data governance on Google Cloud. It allows users to define, validate, and enforce data policies using natural language queries, translating them into executable code that runs against **Google Cloud Dataplex** and **BigQuery** metadata.

The [Agent Starter Pack](https://goo.gle/agent-starter-pack) (ASP) is the **recommended** way to create a new project from this sample: you get deployment options and CI/CD scaffolding. The copy in [dataplex-labs](https://github.com/GoogleCloudPlatform/dataplex-labs) is the upstream source for browsing and contributions.

## Prerequisites

*   **Python 3.11+**
*   **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — fast Python package manager
*   **Google Cloud SDK (`gcloud`)** installed and authenticated
*   **Git**

## Getting Started

To explore this sample or contribute, you can run the agent directly from this directory in the repository.

1.  **Install dependencies**:
    ```bash
    uv sync --group dev
    ```

2.  **Configure environment**:
    Copy the example configuration file:
    ```bash
    cp .env.example .env
    ```
    Open `.env` and fill in your details:
    *   `GOOGLE_CLOUD_PROJECT`: Your Google Cloud Project ID.
    *   `GOOGLE_CLOUD_LOCATION`: (e.g., `us-central1`).
    *   `ENABLE_MEMORY_BANK`: Set to `True` to enable long-term memory (requires Firestore). Set to `False` to run without it. See [Memory Integration](./docs/MEMORY_INTEGRATION.md) for details.
    *   `FIRESTORE_DATABASE`: (Optional) Leave as `(default)` unless using a named database.

3.  **Authenticate with Google Cloud**:
    ```bash
    gcloud auth application-default login
    ```

## Running the Agent

From the agent directory (`policy-as-code`):

```bash
uv run adk run policy_as_code_agent
```

Or use the web UI:

```bash
uv run adk web
```

**Optional:** To enable short-term contextual memory (Agent Engine) for better conversation history:

```bash
uv run adk web --memory_service_uri="agentengine://AGENT_ENGINE_ID"
```

Open the printed URL in your browser to chat with the agent.

## Running Tests

```bash
uv run pytest
```

Run only fast unit tests:

```bash
uv run pytest tests/unit -v
```

Integration tests are marked and may require GCP credentials and a configured `.env`.

## Creating a New Project (Agent Starter Pack)

If you want to use this sample as a base to create and deploy a **new, independent project** for production, we recommend using the Agent Starter Pack. This provides deployment options and CI/CD scaffolding.

Start from a new directory (replace `my-policy-as-code` with your project name) and run:

```bash
uvx agent-starter-pack create my-policy-as-code -a adk@policy-as-code
```

This will scaffold a new project and prompt you for deployment options.

---

## Key Features

*   **Natural Language Policies**: "All tables in the finance dataset must have a description."
*   **Hybrid Execution**: Generates Python code on-the-fly for flexibility, but executes it in a sandboxed environment for safety.
*   **Memory & Learning**: Uses **Firestore** and **Vector Search** to remember valid policies. If you ask a similar question later, it reuses the proven code instead of regenerating it.
*   **Dual-Mode Operation**:
    *   **Live Mode**: Queries the **Dataplex Universal Catalog** in real-time.
    *   **Offline Mode**: Analyzes metadata exports stored in **Google Cloud Storage (GCS)**.
*   **Compliance Scorecards**: Run a full health check on your data assets with a single command.
*   **Remediation**: Can suggest specific fixes for identified violations.

## Architecture

The agent is built using the **Google Cloud Agent Development Kit (ADK)** and leverages several Google Cloud services:

*   **Gemini 2.5 Pro**: For complex code generation (converting natural language to Python).
*   **Gemini 2.5 Flash**: For conversational logic, tool selection, and remediation suggestions.
*   **Vertex AI Vector Search**: For semantic retrieval of past policies.
*   **Firestore**: Stores policy definitions, versions, and execution history.
*   **Dataplex API**: For fetching live metadata.

### Project Structure

*   `policy_as_code_agent/`
    *   `__init__.py`: Application Default Credentials and Vertex environment defaults for ASP/local runs.
    *   `agent.py`: Entry point and core agent definition.
    *   `memory.py`: Handles Firestore interactions (saving/retrieving policies).
    *   `utils/`: Utility modules for LLM logic, Dataplex, GCS, and common tools.
    *   `simulation.py`: Sandboxed execution engine for running policy code.
    *   `prompts/`: Markdown templates for LLM instructions.
*   `tests/`: Unit and integration tests.
*   `data/`: Sample metadata for local testing.

## Documentation

For deep dives into the implementation, check the `docs/` folder:
- [High-Level Architecture](./docs/HIGH_LEVEL_DETAILS.md)
- [Low-Level Implementation](./docs/LOW_LEVEL_DETAILS.md)
- [Memory Implementation](./docs/MEMORY_IMPLEMENTATION.md)
