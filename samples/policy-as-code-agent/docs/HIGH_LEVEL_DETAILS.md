# Policy-as-Code Agent: High-Level Details

## Purpose

The Policy-as-Code Agent is designed to automate and streamline data governance by enabling users to define and validate data policies using natural language. It addresses the challenges of manual governance checks and the inflexibility of traditional rule-based systems.

## Value Proposition

### Technical (CEs/SAs)
*   **Agentic AI**: Replaces static rules with generative logic. The LLM writes Python policy checks on-the-fly, showcasing advanced reasoning.
*   **Hybrid Execution**: Combines LLM intent parsing with deterministic Python execution. This eliminates hallucinations during enforcement.
*   **Intelligent Memory**: Vector-search memory (Firestore) caches and learns successful policies, optimizing latency and cost—a key production pattern.
*   **Dual-Mode**: Flexible execution against offline GCS exports or live Dataplex API, demonstrating versatile integration.

### Business (Sales/FSRs)
*   **Democratized Governance**: Enables non-tech stakeholders to audit data via natural language, removing engineering bottlenecks.
*   **Proactive Risk**: "Compliance-as-code" instantly tests policies (e.g., retention rules), mitigating regulatory fines.
*   **Efficiency**: Automates manual dataset inspections, turning days of work into seconds.
*   **Self-Healing**: Moves beyond monitoring to active governance by suggesting remediation for violations.

## 1. How It Works: From Query to Report

The agent follows a simple, powerful, five-step process:

1.  **Search the Memory**: When a user provides a policy, the agent first semantically searches its internal memory to see if it has already generated code for a similar policy. The search can be filtered by author and date range.
2.  **Understand the Policy**: If no cached policy is found, a user provides a policy in natural language, like *"All datasets in the 'finance' domain must have a 'data_owner' label."*
3.  **Generate and Cache the Logic**: The agent's core, powered by the Gemini LLM, dynamically writes a small, targeted Python script to check for that policy. Once generated, the agent saves this new policy to its memory for future use. The memory is version-controlled, so updates to a policy create a new version.
4.  **Execute and Report**: The agent runs the Python script (either from the cache or newly generated) against your chosen metadata source—either a static metadata export from GCS or live results from a Dataplex Universal Catalog search. It then reports any resources found to be in violation of the policy.
5.  **Suggest Remediation**: If violations are found, the agent can, at the user's request, use the LLM to suggest actionable remediation steps for each violation.
6.  **Feedback and Ranking**: After a policy is used, the user can rate it. This feedback is used to rank policies, so the best ones are suggested first.

## 2. Key Features

*   **Natural Language Interface**: No coding or specialized query languages required.
*   **Intelligent, Version-Controlled Memory**: The agent caches successfully generated policies. When it receives a new query, it first searches its memory for a similar policy to reuse, saving time, reducing costs, and ensuring that the same policy is always executed in the same way. The memory supports:
    *   **Versioning**: Policies can be updated, and the agent will keep track of the different versions.
    *   **Pruning**: Old and unused policies can be automatically removed from the memory.
    *   **Enhanced Search**: Policies can be searched by author and date range.
    *   **Ranking**: Policies are ranked based on user feedback, so the most effective policies are suggested first.
*   **Dynamic and Flexible**: Generates code on-the-fly to support complex and nuanced policies.
*   **Flexible Data Sources**: Operates on either static metadata exports from GCS for offline analysis or on live Dataplex search results for real-time validation.
*   **Actionable Reporting**: Pinpoints exact violations for rapid remediation.
*   **Actionable Remediation Suggestions**: Provides clear, actionable steps to fix policy violations.

## 3. Technical Deep Dive

*   **Large Language Model (LLM):** The agent uses a dual-model approach for optimal performance and cost-efficiency:
    *   **Gemini 2.5 Flash:** Used for the agent's conversational logic and routing user requests to the appropriate tools.
    *   **Gemini 2.5 Pro:** Leveraged for the most complex task: generating accurate, executable Python code from natural language policies.
*   **Agentic AI Architecture:** This agent is an example of **Agentic AI**, which is more advanced than a traditional **AI Agent**.
    *   **AI Agent vs. Agentic AI:**
        *   An **AI Agent** typically follows pre-programmed rules or a narrowly trained model to perform a specific task.
        *   **Agentic AI** is a more advanced paradigm where the system can autonomously reason, plan, and execute a series of steps to achieve a high-level goal. It can adapt, learn, and use tools to solve complex problems without direct instruction for each step.
    *   **Why This is Agentic AI:**
        *   **Dynamic Code Generation:** The agent doesn't just run a pre-written policy checker; it **creates the checker on the fly** by translating natural language into executable Python. This demonstrates a high degree of reasoning and autonomy.
        *   **Adaptability:** It is not limited to a fixed set of policies. It can handle new and unforeseen policy requests without needing to be reprogrammed.
        *   **Autonomous Tool Use:** The agent autonomously chains its tools together—first generating the policy code, then executing it—to fulfill the user's request seamlessly.
    *   **Planning and Execution:**
        *   **Planning:** The LLM's first task is to *plan* its approach by converting the user's English query into a logical, executable Python function. This is guided by a sophisticated prompt template (`prompts/v4.md`) that provides the LLM with context, the metadata schema, and dynamically generated examples from the user's own data.
        *   **Execution:** The agent then takes this generated code and runs it using Python's `exec()` function to perform the actual validation.
*   **Core Components:**
    *   **`llm_generate_policy_code`:** The "brain" of the agent. This function packages the user's query into a detailed prompt and sends it to the Gemini LLM to get the Python validation code back.
    *   **`run_simulation`:** The "engine room." This function takes the Python code from the LLM and executes it against the metadata, collecting and formatting any violations.
    *   **Metadata Sources:** The agent can source metadata from two places:
        *   **GCS Loader:** A utility that can read metadata exports from a Google Cloud Storage (GCS) bucket.
        *   **Dataplex Search:** A tool that directly queries the Dataplex Universal Catalog and fetches full entry details in real-time.
*   **Technology Stack:**
    *   **Primary Language:** Python
    *   **Key Libraries:**
        *   `vertexai`: To interact with the Gemini LLM.
        *   `google-cloud-firestore`: To interact with the Firestore database for memory.
        *   `google-cloud-storage`: To read metadata files from GCS.
        *   `google-cloud-dataplex`: To interact with the Dataplex API.
        *   `google-adk`: The framework for building the agent.
    *   **Data Format:** The agent is designed to consume **JSONL** (JSON Lines) formatted metadata exports, which is a standard output from Dataplex.
*   **Security:**
    *   **AST Analysis:** Before any code is executed, the agent performs static analysis using Python's Abstract Syntax Tree (AST) module. This detects and blocks dangerous imports (like `os`, `sys`, `subprocess`) and unsafe function calls (like `eval`, `open`).
    *   **Restricted Execution:** The dynamic execution of code is handled within a restricted environment using `exec()`, where access is limited to a safe allowlist of libraries (`json`, `re`, `datetime`) and standard built-ins.
*   **Extensibility:** New and unforeseen policy types can be supported instantly without any changes to the agent's underlying code, as the LLM can generate the required logic on demand.

## 4. Usage Example

1.  **User Input (Natural Language):**
    > "The 'sensitivity' label must be applied to all tables in public_data dataset"

2.  **Agent's Generated Code (Simplified):**
    ```python
    def check_policy(metadata: list) -> list:
        violations = []
        for resource in metadata:
            # Logic to check if the resource is a table within the 'public_data' dataset
            # Logic to check if the 'sensitivity' label is missing
            if is_in_public_data_dataset and sensitivity_label_is_missing:
                violations.append({
                    "resource_name": resource['fullyQualifiedName'],
                    "violation": "Table is in 'public_data' dataset but is missing the 'sensitivity' label."
                })
        return violations
    ```

3.  **Final Output to User:**
    > **Policy Violations Found:**
    > *   **Resource:** `bigquery:data-governance-agent-dev.public_data.daily_active_users`
    >     *   **Violation:** Table is in 'public_data' dataset but is missing the 'sensitivity' label.
    > *   **Resource:** `bigquery:data-governance-agent-dev.public_data.website_commenters`
    >     *   **Violation:** Table is in 'public_data' dataset but is missing the 'sensitivity' label.

## 5. Advanced Capabilities

### 📋 Compliance Scorecard & Reporting
The agent offers robust tools for high-level governance reporting:
*   **Compliance Scorecard**: Run a "health check" on your data (e.g., `"Generate a compliance scorecard for my dataplex assets"`). The agent runs a suite of **Core Policies** and calculates a compliance score.
*   **Configurable Core Policies**: Define what "compliance" means for your organization. View, add, remove, and save your own set of Core Policies to the agent's memory.
*   **Rich Reporting**: Export violation reports to **CSV** or **HTML** for offline sharing, or upload them directly to Google Cloud Storage.

### 📊 Policy Analytics & History
The agent tracks all policy executions, enabling advanced analysis:
*   **Execution History**: Ask about past runs (e.g., `"What policies failed yesterday?"`).
*   **Top Violations**: Identify the most problematic policies.
*   **Resource Search**: Find all violations for a specific resource using partial names.
*   **Top Violated Resources**: Discover which assets are most non-compliant.

### 🔌 Model Context Protocol (MCP) Integration
The agent is compatible with the **Model Context Protocol (MCP)**.
*   **Dataplex MCP**: Connects to a Dataplex MCP server to access additional tools for interacting with Dataplex resources.
*   **Extensibility**: Allows the agent to gain new capabilities by connecting to other MCP-compliant servers.
