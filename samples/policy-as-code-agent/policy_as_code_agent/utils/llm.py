import json
import os
import re

import vertexai
from vertexai.generative_models import GenerativeModel

from ..config import (
    GEMINI_MODEL_PRO,
    LOCATION,
    PROJECT_ID,
    PROMPT_CODE_GENERATION_FILE,
)
from .json_tools import traverse

script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def generate_sample_values_str(metadata_sample: list) -> str:
    """Generates a string of sample values from metadata."""
    if not metadata_sample:
        return "{}"

    # Find the most representative entry (largest one) to generate sample values from.
    # This avoids using a sparse entry like 'entrygroup' if a richer one like 'table' is available.
    try:
        most_representative_entry = max(
            metadata_sample, key=lambda item: len(json.dumps(item))
        )
    except (TypeError, ValueError):
        # Fallback to the first item if max fails for any reason
        most_representative_entry = metadata_sample[0]

    sample_values = {}
    traverse(most_representative_entry, sample_values)

    return json.dumps(sample_values, indent=2)


def get_json_schema_from_content(content: str):
    """Reads a JSON/JSONL string and returns a schema representation of all objects."""
    try:
        # Check if the content is JSONL or JSON
        if content.strip().startswith("["):
            data = json.loads(content)
        else:
            data = [
                json.loads(line)
                for line in content.splitlines()
                if line.strip()
            ]
    except json.JSONDecodeError:
        return {}

    if not data:
        return {}

    def merge_schemas(schema1, schema2):
        if isinstance(schema1, dict) and isinstance(schema2, dict):
            merged = schema1.copy()
            for key, value in schema2.items():
                if key in merged:
                    merged[key] = merge_schemas(merged[key], value)
                else:
                    merged[key] = value
            return merged
        elif isinstance(schema1, list) and isinstance(schema2, list):
            if schema1 and schema2:
                return [merge_schemas(schema1[0], schema2[0])]
            elif schema2:
                return schema2
            else:
                return schema1
        else:
            return schema2

    def generate_schema_from_obj(obj):
        if isinstance(obj, dict):
            schema = {}
            for k, v in obj.items():
                schema[k] = generate_schema_from_obj(v)
            return schema
        elif isinstance(obj, list):
            if obj:
                # To make the schema more comprehensive, we merge schemas of all items
                item_schemas = [generate_schema_from_obj(item) for item in obj]
                if not item_schemas:
                    return []
                merged_item_schema = item_schemas[0]
                for item_schema in item_schemas[1:]:
                    merged_item_schema = merge_schemas(
                        merged_item_schema, item_schema
                    )
                return [merged_item_schema]
            else:
                return []
        else:
            return type(obj).__name__

    if not isinstance(data, list):
        return generate_schema_from_obj(data)

    all_schemas = [
        generate_schema_from_obj(item)
        for item in data
        if isinstance(item, dict)
    ]
    if not all_schemas:
        return {}

    final_schema = all_schemas[0]
    for schema in all_schemas[1:]:
        final_schema = merge_schemas(final_schema, schema)

    return final_schema


def llm_generate_policy_code(
    query: str, schema: dict, metadata_sample: list
) -> str:
    """Generates a Python function that evaluates a policy query using Vertex AI."""
    try:
        vertexai.init(project=PROJECT_ID, location=LOCATION)
        model = GenerativeModel(GEMINI_MODEL_PRO)
    except Exception as e:
        return f"# Error initializing Vertex AI: {e}"

    schema_str = json.dumps(schema, indent=2)
    sample_values_str = generate_sample_values_str(metadata_sample)

    # Load the prompt from the file
    try:
        prompt_path = os.path.join(
            script_dir, "prompts", PROMPT_CODE_GENERATION_FILE
        )

        with open(prompt_path) as f:
            prompt_template = f.read()
    except FileNotFoundError:
        return f"# Error: Prompt file not found at prompts/{PROMPT_CODE_GENERATION_FILE}"

    # Replace placeholders in the prompt
    prompt = prompt_template.replace("{{INFERRED_JSON_SCHEMA}}", schema_str)
    prompt = prompt.replace("{{USER_POLICY_QUERY}}", query)
    prompt = prompt.replace("{{SAMPLE_VALUES}}", sample_values_str)

    response = model.generate_content(prompt)
    match = re.search(r"```python\n(.*)\n```", response.text, re.DOTALL)
    if match:
        return match.group(1)
    else:
        # Fallback for cases where the LLM doesn't use markdown
        code = response.text.strip()
        if "def check_policy" in code:
            return code
        return f"# Error: Could not extract Python code from the LLM response.\n# Response:\n# {response.text}"
