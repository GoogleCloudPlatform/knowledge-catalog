# Memory Bank Integration

This document outlines the integration of a long-term memory bank with the Policy-as-Code agent to provide stateful, context-aware policy evaluation.

## Architecture: Firestore + Vector Search

The agent's memory is built on **Google Cloud Firestore** using its **Native Vector Search** capabilities.

*   **Storage:** Policy metadata (code, author, creation date, ratings) is stored as documents in a Firestore collection.
*   **Semantic Search:** The natural language query is converted into a vector embedding using **Vertex AI (`text-embedding-004`)**. This vector is stored in the Firestore document.
*   **Retrieval:** When a user asks for a policy, the agent performs a cosine similarity search directly within Firestore to find the most relevant existing policies.

## Configuration & Setup

### 1. Enable Firestore (Native Mode)
To use the memory bank, you must have a Firestore database created in your Google Cloud project.

1.  Go to the [Firestore Console](https://console.cloud.google.com/firestore).
2.  Click **Create Database**.
3.  Select **Native Mode** (required for Vector Search).
4.  Choose your location (e.g., `us-central1`).
5.  Create the database (default name is usually `(default)`).

### 2. Configure Environment Variables
The following variables in your `.env` file control the memory bank:

```bash
# Enable/Disable the entire memory subsystem
ENABLE_MEMORY_BANK=True  # Set to False to run without Firestore

# Firestore Configuration
FIRESTORE_DATABASE="(default)" 
FIRESTORE_COLLECTION_POLICIES="policies"
FIRESTORE_COLLECTION_EXECUTIONS="policy_executions"
CORE_POLICIES_DOC_REF="configurations/core_policies"

# Vector Search Model
EMBEDDING_MODEL_NAME="text-embedding-004"
```

### 3. Graceful Fallback
The agent is designed to handle missing infrastructure gracefully.

*   **Auto-Disable:** If `ENABLE_MEMORY_BANK=True` but the agent cannot connect to the Firestore database (e.g., it doesn't exist or permissions are missing), the agent will log a warning and automatically disable memory features for the session. It will **not** crash.
*   **Instructional Messages:** If you attempt to use a memory-dependent tool (like "find similar policies" or "show execution history") while memory is disabled, the agent will return a helpful message explaining that memory is disabled and pointing to this documentation.
*   **Core Functionality:** All core policy generation and evaluation features (`generate_policy`, `run_simulation`) continue to work fully without the memory bank.

## 📊 Analytics and Reporting

The agent tracks detailed execution logs in Firestore, enabling powerful analytical capabilities:

### Features
1.  **Execution History**: Track success, failure, and violation rates over time.
2.  **Top Violations**: Aggregated view of which policies are failing most frequently.
3.  **Resource Search**: Fuzzy search to find all violations associated with a specific resource (table, dataset, etc.).
4.  **Top Violated Resources**: Identify "hotspot" assets that consistently violate policies.

### Sample Prompts
*   **History**: `"What happened yesterday?"`, `"Show me all failed policy runs from last week."`
*   **Top Violations**: `"Which policies are violated the most?"`, `"What are my top compliance issues?"`
*   **Resource Search**: `"Did 'finance_table' have any violations?"`, `"Check logs for 'quarterly_earnings'."`
*   **Top Resources**: `"What are the top 10 most violated resources?"`, `"Which tables are most non-compliant?"`

## Key Benefits

Integrating this persistent memory system transforms the agent from a stateless policy checker into a learning, stateful governance assistant.

### 1. Scalability and Concurrency
Unlike a local file-based memory, Firestore allows multiple agent instances to share the same knowledge base simultaneously. It scales to millions of policies without performance degradation.

### 2. Historical Context and Trend Analysis
By storing the results of policy runs over time, the agent could answer much more sophisticated questions.

*   **Current State:** You can ask, "Does any dataset in 'marketing' have more than one PII column?"
*   **With Memory:** You could ask, "Have any *new* datasets in 'marketing' become non-compliant with the PII policy in the last 7 days?" or "Show me the compliance trend for our data ownership policies over the last quarter."

### 3. Learning User Intent and Personalization
The agent could remember a user's common queries, domains of interest, and corrections, leading to a more efficient workflow.

*   **Problem:** A data steward for the 'finance' domain has to type out the full policy query specifying the 'finance' domain each time.
*   **With Memory:** After a few queries, the agent could learn this preference. The user could simply ask, "Run the standard ownership check," and the agent would know to apply it to the 'finance' domain.

### 4. Intelligent Caching and Performance
Memory is used as a semantic cache for the LLM-generated Python code, saving time and cost.

*   **Problem:** If you run the exact same natural language policy query twice, the agent currently calls the LLM to generate the same Python code twice.
*   **With Memory:** The agent stores a mapping of the natural language query (vector) to the successfully generated Python function. If a similar query is asked again, it retrieves the code from Firestore instead of making a new LLM call.

### 5. Root Cause Analysis and Remediation
By remembering the context of past failures, the agent could provide better suggestions for remediation.

*   **Current State:** The agent reports that "Table X is missing an owner."
*   **With Memory:** The agent might remember that "Table X" was created by the same service account that created 10 other unowned tables. It could then suggest a more systemic fix.