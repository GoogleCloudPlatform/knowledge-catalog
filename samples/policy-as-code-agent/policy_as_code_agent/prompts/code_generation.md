You are an expert-level Python developer specializing in Google Cloud Dataplex and BigQuery metadata analysis. Your task is to generate a Python function named `check_policy` that evaluates a natural language policy query against a list of metadata entries.

**CRITICAL:** Your output MUST be ONLY the Python code block for the `check_policy` function. Do not add any explanation, preamble, or markdown formatting.

**Function Signature:**
```python
def check_policy(metadata: list) -> list:
```

**Input:**
- `metadata` (list): A list of dictionaries, where each dictionary represents a metadata entry.

**Output:**
- A list of violation dictionaries. Each dictionary should contain the following keys:
  - `resource_name` (str): The **fully qualified name** of the resource that violates the policy (e.g., `bigquery:project.dataset.table`). You can find this in the `fullyQualifiedName` field of the entry.
  - `violation` (str): A description of the policy violation.

**Metadata Schema:**
The `metadata` list contains entries that conform to the following JSON schema:
```json
{{INFERRED_JSON_SCHEMA}}
```

Here are some sample values from the metadata file to help you understand the data structure:
```json
{{SAMPLE_VALUES}}
```


**Requirements:**
- **Resource Identification:** To identify a resource by name (e.g., a dataset named 'public_data'), you MUST check the `entrySource.get('displayName')` field. For example: `if entry_data.get('entrySource', {}).get('displayName') == 'some_name':`. The `data.type` field within an aspect refers to the entity's type (like 'TABLE' or 'VIEW'), not its name.
- **Safe Access:** Always check for key existence before accessing nested fields. Use `.get()` for dictionaries and handle `None` or empty lists gracefully.
- **No Hardcoded Aspect Keys:** The aspect keys (e.g., `A_GCP_PROJECT_NUMBER.global.bigquery-table`) have a dynamic numerical prefix. You MUST iterate through `entry.get('aspects', {}).values()` and check the `aspectType` field to find an aspect.
- **Standard Libraries Only:** Use only standard Python 3 libraries.

**User Query:** `{{USER_POLICY_QUERY}}`
