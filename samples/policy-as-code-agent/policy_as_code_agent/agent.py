import concurrent.futures
import csv
import json
import logging
import os
import time
from typing import Any

import vertexai
from google.adk.agents import Agent
from google.adk.tools.preload_memory_tool import PreloadMemoryTool
from google.cloud import dataplex_v1, storage
from vertexai.generative_models import GenerativeModel

from .config import (
    DEFAULT_CORE_POLICIES,
    GEMINI_MODEL_FLASH,
    LOCATION,
    MAX_REMEDIATION_WORKERS,
    PROJECT_ID,
    PROMPT_INSTRUCTION_FILE,
    PROMPT_REMEDIATION_FILE,
)
from .mcp import _get_dataplex_mcp_toolset
from .memory import (
    add_core_policy,
    analyze_execution_history,
    find_policy_in_memory,
    get_active_core_policies,
    get_execution_history,
    get_policy_by_id,
    list_policy_versions,
    log_policy_execution,
    prune_memory,
    rate_policy,
    remove_core_policy,
    save_core_policies,
    save_policy_to_memory,
)
from .utils.dataplex import entry_to_dict, get_project_id
from .utils.gcs import get_content_from_gcs_for_schema, load_metadata
from .utils.llm import get_json_schema_from_content, llm_generate_policy_code

# Initialize Vertex AI globally to ensure all clients (including ADK's memory service)
# use the correct project and location.
try:
    vertexai.init(project=PROJECT_ID, location=LOCATION)
except Exception as e:
    logging.error(f"Failed to initialize Vertex AI globally: {e}")

from .simulation import run_simulation, validate_code_safety

# Get the absolute path of the directory where the script is located
script_dir = os.path.dirname(os.path.abspath(__file__))


def generate_policy_code_from_gcs(query: str, gcs_uri: str) -> dict:
    """
    Generates Python policy code from a natural language query using a GCS file for schema.
    """
    logging.info(
        f"Generating policy code for query: '{query}' using schema from '{gcs_uri}'"
    )

    content_response = get_content_from_gcs_for_schema(gcs_uri)
    if content_response["status"] == "error":
        return content_response

    content = content_response["content"]
    schema = get_json_schema_from_content(content)

    # Parse content to list of dicts for sample values
    try:
        metadata_sample = [
            json.loads(line) for line in content.splitlines() if line.strip()
        ]
    except json.JSONDecodeError:
        metadata_sample = []

    policy_code = llm_generate_policy_code(query, schema, metadata_sample)

    if policy_code.startswith("# Error:") or policy_code.startswith(
        "# API key not configured"
    ):
        logging.error(f"Error generating policy code: {policy_code}")
        return {"status": "error", "error_message": policy_code}

    security_errors = validate_code_safety(policy_code)
    if security_errors:
        error_msg = "; ".join(security_errors)
        logging.error(f"Generated policy code failed safety check: {error_msg}")
        return {"status": "error", "error_message": error_msg}

    return {"status": "success", "policy_code": policy_code}


def _handle_policy_results(
    violations: list,
    policy_id: str | None,
    version: int,
    source: str,
    asset_count: int,
    report_message_suffix: str = "",
) -> dict:
    """Helper to process simulation results, log execution, and format the report."""
    if policy_id:
        status = "violations_found" if violations else "success"
        summary = (
            f"Scanned {asset_count} assets. {len(violations)} violations found."
        )
        # Pass the full violations list to log specific resources
        log_policy_execution(
            policy_id, version, status, source, violations, summary
        )

    if violations:
        return {
            "status": "success",
            "report": {
                "violations_found": True,
                "violations": violations,
                "message": f"{report_message_suffix}",
            },
        }
    else:
        return {
            "status": "success",
            "report": {
                "violations_found": False,
                "message": f"No policy violations found. {report_message_suffix}",
            },
        }


def run_policy_from_gcs(
    policy_code: str,
    gcs_uri: str,
    policy_id: str | None = None,
    version: int = 0,
) -> dict:
    """
    Runs a policy simulation against a metadata file or directory from GCS.
    """
    try:
        storage_client = storage.Client()
        gcs_path = gcs_uri.replace("gs://", "")
        path_parts = gcs_path.split("/", 1)
        bucket_name = path_parts[0]
        blob_prefix = path_parts[1] if len(path_parts) > 1 else ""
        bucket = storage_client.bucket(bucket_name)
        blobs = list(storage_client.list_blobs(bucket_name, prefix=blob_prefix))
        is_directory = len(blobs) > 1 or (
            len(blobs) == 1 and blobs[0].name.endswith("/")
        )
        is_file = not is_directory

    except Exception as e:
        if policy_id:
            log_policy_execution(
                policy_id,
                version,
                "failure",
                "gcs",
                summary=f"GCS Access Error: {e}",
            )
        return {
            "status": "error",
            "error_message": f"Error accessing GCS URI {gcs_uri}: {e}",
        }

    if is_directory:
        all_blobs_in_dir = list(
            storage_client.list_blobs(bucket, prefix=blob_prefix)
        )
        files_to_process = [
            f"gs://{bucket_name}/{b.name}"
            for b in all_blobs_in_dir
            if not b.name.endswith("/")
            and b.name[len(blob_prefix) :].count("/") == 0
        ]

        if not files_to_process:
            if policy_id:
                log_policy_execution(
                    policy_id,
                    version,
                    "failure",
                    "gcs",
                    summary="No files found in GCS directory",
                )
            return {
                "status": "error",
                "error_message": f"No files found in GCS directory {gcs_uri}",
            }

        all_violations = []

        def process_file(file_uri):
            metadata = load_metadata(gcs_uri=file_uri)
            if isinstance(metadata, dict) and "error" in metadata:
                return [
                    {
                        "source_file": file_uri,
                        "policy": "Loading Error",
                        "violation": metadata["error"],
                    }
                ]

            violations = run_simulation(policy_code, metadata)
            for v in violations:
                v["source_file"] = file_uri
            return violations

        with concurrent.futures.ThreadPoolExecutor() as executor:
            future_to_file = {
                executor.submit(process_file, file_uri): file_uri
                for file_uri in files_to_process
            }
            for future in concurrent.futures.as_completed(future_to_file):
                file_uri = future_to_file[future]
                try:
                    violations_from_file = future.result()
                    all_violations.extend(violations_from_file)
                except Exception as exc:
                    all_violations.append(
                        {
                            "source_file": file_uri,
                            "policy": "Execution Error",
                            "violation": f"An exception occurred during processing: {exc}",
                        }
                    )

        report_message = f"This is a directory. The policy check ran on {len(files_to_process)} files at the root level."
        return _handle_policy_results(
            all_violations,
            policy_id,
            version,
            "gcs",
            len(files_to_process),
            report_message,
        )

    elif is_file:
        metadata = load_metadata(gcs_uri=gcs_uri)
        if isinstance(metadata, dict) and "error" in metadata:
            if policy_id:
                log_policy_execution(
                    policy_id,
                    version,
                    "failure",
                    "gcs",
                    summary=f"Metadata Load Error: {metadata['error']}",
                )
            return {"status": "error", "error_message": metadata["error"]}

        violations = run_simulation(policy_code, metadata)

        if violations and violations[0].get("policy") == "Configuration Error":
            if policy_id:
                log_policy_execution(
                    policy_id,
                    version,
                    "failure",
                    "gcs",
                    summary=f"Config Error: {violations[0]['violation']}",
                )
            return {
                "status": "error",
                "error_message": violations[0]["violation"],
            }

        return _handle_policy_results(violations, policy_id, version, "gcs", 1)

    else:
        return {
            "status": "error",
            "error_message": f"The GCS URI {gcs_uri} could not be processed.",
        }


def _get_remediation_with_retry(model, violation, max_retries=3):
    """Gets a remediation suggestion for a single violation with exponential backoff."""
    base_delay = 1

    try:
        prompt_path = os.path.join(
            script_dir, "prompts", PROMPT_REMEDIATION_FILE
        )
        with open(prompt_path) as f:
            prompt_template = f.read()
    except FileNotFoundError:
        return {
            "violation": violation,
            "suggestion": "Error: Remediation prompt file not found.",
        }

    for _ in range(max_retries):
        try:
            prompt = prompt_template.replace(
                "{{VIOLATION_DETAILS}}", json.dumps(violation, indent=2)
            )
            response = model.generate_content(prompt)
            return {"violation": violation, "suggestion": response.text.strip()}
        except Exception as e:
            logging.warning(
                f"Error getting remediation for violation {violation.get('resource_name')}: {e}. Retrying in {base_delay} seconds..."
            )
            time.sleep(base_delay)
            base_delay *= 2

    logging.error(
        f"Failed to get remediation for violation {violation.get('resource_name')} after {max_retries} retries."
    )
    return {
        "violation": violation,
        "suggestion": "Error: Could not generate a remediation suggestion.",
    }


def suggest_remediation(violations: list[dict[str, Any]]) -> dict:
    """Suggests remediation measures for a list of policy violations concurrently."""
    try:
        vertexai.init(project=PROJECT_ID, location=LOCATION)
        model = GenerativeModel(GEMINI_MODEL_FLASH)
    except Exception as e:
        return {
            "status": "error",
            "error_message": f"Error initializing Vertex AI: {e}",
        }

    remediation_suggestions = []
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=MAX_REMEDIATION_WORKERS
    ) as executor:
        future_to_violation = {
            executor.submit(_get_remediation_with_retry, model, v): v
            for v in violations
        }
        for future in concurrent.futures.as_completed(future_to_violation):
            try:
                suggestion = future.result()
                remediation_suggestions.append(suggestion)
            except Exception as exc:
                violation = future_to_violation[future]
                logging.error(
                    f"An exception occurred while processing violation {violation.get('resource_name')}: {exc}"
                )
                remediation_suggestions.append(
                    {
                        "violation": violation,
                        "suggestion": "Error: An unexpected exception occurred during remediation generation.",
                    }
                )

    return {
        "status": "success",
        "remediation_suggestions": remediation_suggestions,
    }


def get_supported_examples() -> dict:
    """Returns a list of example policy queries"""
    return DEFAULT_CORE_POLICIES


def generate_policy_code_from_dataplex(
    policy_query: str, dataplex_query: str
) -> dict:
    """
    Generates policy code by fetching a sample of metadata from a Dataplex query.
    """
    project_id, error_message = get_project_id()
    if error_message:
        return {"status": "error", "error_message": error_message}

    try:
        with dataplex_v1.CatalogServiceClient() as client:
            search_request = dataplex_v1.SearchEntriesRequest(
                name=f"projects/{project_id}/locations/global",
                scope=f"projects/{project_id}",
                query=dataplex_query,
                page_size=5,
            )
            sample_results = list(client.search_entries(request=search_request))

            if not sample_results:
                return {
                    "status": "error",
                    "error_message": "No assets found in Dataplex matching the query.",
                }

            metadata_sample = []
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future_to_name = {
                    executor.submit(
                        client.get_entry, name=res.dataplex_entry.name
                    ): res.dataplex_entry.name
                    for res in sample_results
                }
                for future in concurrent.futures.as_completed(future_to_name):
                    try:
                        full_entry = future.result()
                        metadata_sample.append(entry_to_dict(full_entry))
                    except Exception as e:
                        logging.error(
                            f"Could not fetch details for sample entry {future_to_name[future]}: {e}"
                        )

            if not metadata_sample:
                return {
                    "status": "error",
                    "error_message": "Found assets in search, but failed to fetch their full details for schema generation.",
                }

            schema = get_json_schema_from_content(json.dumps(metadata_sample))
            policy_code = llm_generate_policy_code(
                policy_query, schema, metadata_sample
            )

            if policy_code.startswith("# Error:"):
                return {"status": "error", "error_message": policy_code}

            security_errors = validate_code_safety(policy_code)
            if security_errors:
                error_msg = "; ".join(security_errors)
                logging.error(
                    f"Generated policy code failed safety check: {error_msg}"
                )
                return {"status": "error", "error_message": error_msg}

            return {"status": "success", "policy_code": policy_code}

    except Exception as e:
        return {
            "status": "error",
            "error_message": f"An unexpected error occurred: {type(e).__name__}: {e}",
        }


def run_policy_on_dataplex(
    policy_code: str,
    dataplex_query: str,
    policy_id: str | None = None,
    version: int = 0,
) -> dict:
    """
    Runs a policy against the full set of assets from a Dataplex search.
    """
    project_id, error_message = get_project_id()
    if error_message:
        if policy_id:
            log_policy_execution(
                policy_id,
                version,
                "failure",
                "dataplex",
                summary=f"Project ID Error: {error_message}",
            )
        return {"status": "error", "error_message": error_message}

    try:
        with dataplex_v1.CatalogServiceClient() as client:
            search_request = dataplex_v1.SearchEntriesRequest(
                name=f"projects/{project_id}/locations/global",
                scope=f"projects/{project_id}",
                query=dataplex_query,
            )
            all_results = list(client.search_entries(request=search_request))

            if not all_results:
                if policy_id:
                    log_policy_execution(
                        policy_id,
                        version,
                        "success",
                        "dataplex",
                        summary="No assets found to check.",
                    )
                return {
                    "status": "success",
                    "report": {
                        "violations_found": False,
                        "message": "No assets found in Dataplex matching the query.",
                    },
                }

            metadata = []
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future_to_name = {
                    executor.submit(
                        client.get_entry, name=res.dataplex_entry.name
                    ): res.dataplex_entry.name
                    for res in all_results
                }
                for future in concurrent.futures.as_completed(future_to_name):
                    try:
                        full_entry = future.result()
                        metadata.append(entry_to_dict(full_entry))
                    except Exception as e:
                        logging.error(
                            f"Could not fetch details for entry {future_to_name[future]}: {e}"
                        )

            if not metadata:
                if policy_id:
                    log_policy_execution(
                        policy_id,
                        version,
                        "failure",
                        "dataplex",
                        summary="Found assets but failed to fetch details.",
                    )
                return {
                    "status": "error",
                    "error_message": "Found assets in search, but failed to fetch their full details.",
                }

            violations = run_simulation(policy_code, metadata)

            return _handle_policy_results(
                violations, policy_id, version, "dataplex", len(metadata)
            )

    except Exception as e:
        if policy_id:
            log_policy_execution(
                policy_id,
                version,
                "failure",
                "dataplex",
                summary=f"Unexpected Error: {e}",
            )
        return {
            "status": "error",
            "error_message": f"An unexpected error occurred: {type(e).__name__}: {e}",
        }


def generate_compliance_scorecard(source_type: str, source_target: str) -> dict:
    """
    Runs a suite of core policies against a dataset and calculates a compliance score.

    Args:
        source_type: 'gcs' or 'dataplex'
        source_target: GCS URI or Dataplex Search Query
    """

    # Fetch core policies from memory
    mem_response = get_active_core_policies()
    policies_to_run = []

    if mem_response.get("status") == "success":
        policies_to_run = mem_response.get("policies", [])

    # If empty or unavailable, use defaults
    if not policies_to_run:
        policies_to_run = DEFAULT_CORE_POLICIES

    results = []
    passed_count = 0

    for query in policies_to_run:
        policy_code = ""
        if source_type == "gcs":
            res = generate_policy_code_from_gcs(query, source_target)
            if res.get("status") == "error":
                results.append(
                    {
                        "policy": query,
                        "status": "Error",
                        "details": res.get("error_message"),
                    }
                )
                continue
            policy_code = res.get("policy_code")

            run_res = run_policy_from_gcs(policy_code, source_target)

        elif source_type == "dataplex":
            res = generate_policy_code_from_dataplex(query, source_target)
            if res.get("status") == "error":
                results.append(
                    {
                        "policy": query,
                        "status": "Error",
                        "details": res.get("error_message"),
                    }
                )
                continue
            policy_code = res.get("policy_code")

            run_res = run_policy_on_dataplex(policy_code, source_target)

        else:
            return {
                "status": "error",
                "message": "Invalid source_type. Must be 'gcs' or 'dataplex'.",
            }

        # Check run results
        if run_res.get("status") == "error":
            results.append(
                {
                    "policy": query,
                    "status": "Error",
                    "details": run_res.get("error_message"),
                }
            )
        else:
            report = run_res.get("report", {})
            violations = report.get("violations", [])
            if violations:
                results.append(
                    {
                        "policy": query,
                        "status": "Failed",
                        "violations_count": len(violations),
                    }
                )
            else:
                results.append({"policy": query, "status": "Passed"})
                passed_count += 1

    total_policies = len(policies_to_run)
    score = (passed_count / total_policies) * 100 if total_policies > 0 else 0

    return {
        "status": "success",
        "scorecard": {
            "compliance_score": f"{score:.1f}%",
            "policies_passed": passed_count,
            "total_policies": total_policies,
            "details": results,
        },
    }


def export_report(
    violations: list[dict[str, Any]],
    format: str = "csv",
    filename: str = "report",
    destination: str | None = None,
) -> dict:
    """
    Exports a list of violations to a CSV or HTML file. Optionally uploads to GCS.

    Args:
        violations: List of violation dictionaries.
        format: 'csv' or 'html'
        filename: Base filename (extension will be added).
        destination: Optional GCS URI (e.g., 'gs://my-bucket/reports/') to upload the file.
    """
    if not violations:
        return {"status": "error", "message": "No violations to export."}

    # Normalize filename
    filename = os.path.basename(filename)
    if not filename:
        filename = "report"

    # Strip extension if user provided it
    if filename.lower().endswith(f".{format.lower()}"):
        filename = filename.rsplit(".", 1)[0]

    file_path = f"{filename}.{format.lower()}"

    try:
        if format.lower() == "csv":
            with open(file_path, "w", newline="") as csvfile:
                if not violations:
                    fieldnames = ["policy", "violation"]
                else:
                    fieldnames = list(violations[0].keys())

                writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                writer.writeheader()
                for v in violations:
                    # Ensure row has all keys
                    row = {k: v.get(k, "") for k in fieldnames}
                    writer.writerow(row)

        elif format.lower() == "html":
            # Simple HTML table
            html = "<html><head><style>table {border-collapse: collapse; width: 100%; font-family: Arial, sans-serif;} th, td {text-align: left; padding: 8px; border: 1px solid #ddd;} tr:nth-child(even){background-color: #f2f2f2} th {background-color: #4CAF50; color: white;}</style></head><body>"
            html += "<h2>Compliance Report</h2>"
            html += "<table><thead><tr>"

            keys = (
                list(violations[0].keys())
                if violations
                else ["Policy", "Violation"]
            )
            for k in keys:
                html += f"<th>{k}</th>"
            html += "</tr></thead><tbody>"

            for v in violations:
                html += "<tr>"
                for k in keys:
                    val = v.get(k, "")
                    html += f"<td>{val}</td>"
                html += "</tr>"

            html += "</tbody></table></body></html>"

            with open(file_path, "w") as f:
                f.write(html)
        else:
            return {
                "status": "error",
                "message": "Unsupported format. Use 'csv' or 'html'.",
            }

        # Handle GCS Upload
        if destination and destination.startswith("gs://"):
            try:
                storage_client = storage.Client()

                # Parse bucket and blob
                gcs_path = destination.replace("gs://", "")
                path_parts = gcs_path.split("/", 1)
                bucket_name = path_parts[0]

                # Handle destination as directory or full path
                if len(path_parts) > 1:
                    blob_prefix = path_parts[1]
                    if blob_prefix.endswith("/"):
                        blob_name = (
                            f"{blob_prefix}{os.path.basename(file_path)}"
                        )
                    else:
                        # If user gave full path, use it, but ensure extension matches
                        blob_name = blob_prefix
                        if not blob_name.lower().endswith(f".{format.lower()}"):
                            blob_name += f".{format.lower()}"
                else:
                    blob_name = os.path.basename(file_path)

                bucket = storage_client.bucket(bucket_name)
                blob = bucket.blob(blob_name)
                blob.upload_from_filename(file_path)

                final_uri = f"gs://{bucket_name}/{blob_name}"

                # Clean up local file after upload
                os.remove(file_path)

                return {
                    "status": "success",
                    "message": f"Report exported to GCS: {final_uri}",
                    "gcs_uri": final_uri,
                    "download_instruction": "You can download this file from the Google Cloud Console UI or via gcloud storage.",
                }

            except Exception as e:
                return {
                    "status": "error",
                    "message": f"Failed to upload to GCS: {e}",
                }

        return {
            "status": "success",
            "file_path": os.path.abspath(file_path),
            "message": "Report saved locally.",
        }

    except Exception as e:
        return {"status": "error", "message": f"Failed to export report: {e}"}


async def auto_save_session_to_memory_callback(callback_context):
    if (
        hasattr(callback_context._invocation_context, "memory_service")
        and callback_context._invocation_context.memory_service
    ):
        await callback_context._invocation_context.memory_service.add_session_to_memory(
            callback_context._invocation_context.session
        )


agent_tools = [
    find_policy_in_memory,
    save_policy_to_memory,
    list_policy_versions,
    get_policy_by_id,
    prune_memory,
    rate_policy,
    generate_policy_code_from_gcs,
    run_policy_from_gcs,
    generate_policy_code_from_dataplex,
    run_policy_on_dataplex,
    get_supported_examples,
    suggest_remediation,
    get_execution_history,
    analyze_execution_history,
    generate_compliance_scorecard,
    export_report,
    get_active_core_policies,
    save_core_policies,
    add_core_policy,
    remove_core_policy,
    PreloadMemoryTool(),
]

# Try to add MCP tools
mcp_toolset = _get_dataplex_mcp_toolset()
if mcp_toolset:
    agent_tools.append(mcp_toolset)
    logging.info("Successfully registered Dataplex MCP Toolset.")
else:
    logging.warning(
        "Could not register Dataplex MCP Toolset due to auth failure."
    )

# Load instruction from file
try:
    instruction_path = os.path.join(
        script_dir, "prompts", PROMPT_INSTRUCTION_FILE
    )
    with open(instruction_path) as f:
        agent_instruction = f.read()
except FileNotFoundError:
    logging.error("Instruction file not found. Using fallback.")
    agent_instruction = "You are a helpful agent for checking data policies."

root_agent = Agent(
    name="policy_as_code",
    model=GEMINI_MODEL_FLASH,
    description="Agent to simulate data policies against metadata from GCS or live Dataplex search.",
    instruction=agent_instruction,
    tools=agent_tools,
    after_agent_callback=auto_save_session_to_memory_callback,
)
