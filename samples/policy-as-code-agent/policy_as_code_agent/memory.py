import datetime
import logging
import uuid
from typing import Any

import vertexai
from google.api_core.exceptions import FailedPrecondition
from google.cloud import firestore
from google.cloud.firestore_v1.base_vector_query import DistanceMeasure
from google.cloud.firestore_v1.vector import Vector
from vertexai.language_models import TextEmbeddingModel

from .config import (
    CORE_POLICIES_DOC_REF,
    EMBEDDING_MODEL_NAME,
    ENABLE_MEMORY_BANK,
    FIRESTORE_COLLECTION_EXECUTIONS,
    FIRESTORE_COLLECTION_POLICIES,
    FIRESTORE_DATABASE,
    LOCATION,
    PROJECT_ID,
)

# Initialize Firestore Client
db = None

if ENABLE_MEMORY_BANK:
    try:
        db = firestore.Client(project=PROJECT_ID, database=FIRESTORE_DATABASE)
        logging.info(
            f"Firestore initialized and verified for project: {db.project}, database: {FIRESTORE_DATABASE}"
        )
    except Exception as e:
        logging.warning(
            f"Firestore initialization failed or database not found. Memory bank will be disabled. Error: {e}"
        )
        db = None
else:
    logging.info("Memory bank is disabled via configuration.")

COLLECTION_NAME = FIRESTORE_COLLECTION_POLICIES


def _get_embedding(text: str) -> list[float]:
    """Generates a vector embedding for the given text using Vertex AI."""
    try:
        vertexai.init(project=PROJECT_ID, location=LOCATION)
        model = TextEmbeddingModel.from_pretrained(EMBEDDING_MODEL_NAME)
        embeddings = model.get_embeddings([text])
        return embeddings[0].values
    except Exception as e:
        logging.error(f"Error generating embedding: {e}")
        return []


def _policy_to_dict(doc) -> dict:
    """Helper to convert a Firestore document to a dictionary."""
    data = doc.to_dict()
    # Convert Firestore timestamps to ISO strings for JSON serialization
    if "created_at" in data and isinstance(
        data["created_at"], datetime.datetime
    ):
        data["created_at"] = data["created_at"].isoformat()
    if "last_used" in data and isinstance(data["last_used"], datetime.datetime):
        data["last_used"] = data["last_used"].isoformat()
    # Remove the embedding vector from the output to reduce noise
    if "embedding" in data:
        del data["embedding"]
    return data


def get_active_core_policies() -> dict:
    """Retrieves the configured core policies from Firestore. Returns default status if not set."""
    if not db:
        return {
            "status": "success",
            "source": "default",
            "message": "Memory bank disabled. Using default core policies.",
            "policies": [],
        }

    try:
        doc = db.document(CORE_POLICIES_DOC_REF).get()
        if doc.exists:
            return {
                "status": "success",
                "source": "firestore",
                "policies": doc.to_dict().get("policies", []),
            }
        else:
            return {
                "status": "success",
                "source": "default",
                "message": "No core policies saved in memory. Using defaults.",
                "policies": [],  # Agent logic will fill this with defaults if needed
            }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Error fetching core policies: {e}",
        }


def save_core_policies(policies: list[str]) -> dict:
    """Saves or overwrites the list of core policies in Firestore."""
    if not db:
        return {"status": "error", "message": "Memory bank is disabled."}

    try:
        db.document(CORE_POLICIES_DOC_REF).set(
            {"policies": policies, "updated_at": datetime.datetime.now()}
        )
        return {
            "status": "success",
            "message": "Core policies saved successfully.",
            "policies": policies,
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to save core policies: {e}",
        }


def add_core_policy(policy: str) -> dict:
    """Adds a single policy to the core policies list."""
    if not db:
        return {"status": "error", "message": "Memory bank is disabled."}

    try:
        doc_ref = db.document(CORE_POLICIES_DOC_REF)

        # Use array_union to add unique value
        doc_ref.set(
            {
                "policies": firestore.ArrayUnion([policy]),
                "updated_at": datetime.datetime.now(),
            },
            merge=True,
        )

        # Fetch updated list to return
        updated_doc = doc_ref.get()
        policies = updated_doc.to_dict().get("policies", [])

        return {
            "status": "success",
            "message": f"Added policy: '{policy}'",
            "policies": policies,
        }
    except Exception as e:
        return {"status": "error", "message": f"Failed to add core policy: {e}"}


def remove_core_policy(policy: str) -> dict:
    """Removes a single policy from the core policies list."""
    if not db:
        return {"status": "error", "message": "Memory bank is disabled."}

    try:
        doc_ref = db.document(CORE_POLICIES_DOC_REF)

        # Use array_remove
        doc_ref.set(
            {
                "policies": firestore.ArrayRemove([policy]),
                "updated_at": datetime.datetime.now(),
            },
            merge=True,
        )

        updated_doc = doc_ref.get()
        policies = updated_doc.to_dict().get("policies", [])

        return {
            "status": "success",
            "message": f"Removed policy: '{policy}'",
            "policies": policies,
        }
    except Exception as e:
        return {
            "status": "error",
            "message": f"Failed to remove core policy: {e}",
        }


def find_policy_in_memory(
    query: str,
    source: str,
    version: str = "latest",
    author: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """
    Finds a similar policy in Firestore using Vector Search.

    Args:
        query: The natural language query for the policy.
        source: The source of the policy ('gcs' or 'dataplex').
        threshold: The similarity threshold (unused directly in find_nearest, but useful for post-filter).
        version: The version of the policy to retrieve ('latest' or a specific version number).
        author: An optional author to filter by.
        start_date: An optional start date in ISO format.
        end_date: An optional end date in ISO format.
    """
    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    query_embedding = _get_embedding(query)
    if not query_embedding:
        return {
            "status": "error",
            "message": "Failed to generate embedding for query.",
        }

    # Base collection reference
    policies_ref = db.collection(COLLECTION_NAME)

    # Note: Firestore Vector Search currently requires a vector index.
    # Pre-filtering (where clause) requires a composite index with the vector field.
    # For simplicity/robustness, we'll do the vector search first, then filter in memory
    # if the result set is small, OR we rely on the composite index if the user sets it up.

    # Let's try to strictly filter by 'source' as it's a primary partition.
    # Requires: Composite Index (source ASC, embedding VECTOR)

    try:
        # Vector Search Query
        vector_query = policies_ref.find_nearest(
            vector_field="embedding",
            query_vector=Vector(query_embedding),
            distance_measure=DistanceMeasure.COSINE,
            limit=10,  # Fetch top 10 matches
            distance_result_field="similarity_distance",  # returns distance (lower is better for Cosine in Firestore? No, Cosine distance is 1 - similarity)
            # Firestore Cosine Distance: range [0, 2]. 0 is identical.
        )

        # Execute query
        results = list(vector_query.stream())

    except FailedPrecondition as e:
        if "index" in str(e).lower():
            return {
                "status": "error",
                "message": f"Firestore Vector Index missing. Please create the index using the link in the logs. Error: {e}",
            }
        return {"status": "error", "message": f"Vector search failed: {e}"}
    except Exception as e:
        return {
            "status": "error",
            "message": f"An unexpected error occurred: {e}",
        }

    if not results:
        return {"status": "not_found", "message": "No policies found."}

    matches = []
    for doc in results:
        data = _policy_to_dict(doc)
        distance = doc.get("similarity_distance")
        # Convert distance to similarity score (approximate for user display)
        # Cosine distance = 1 - Cosine Similarity. So Similarity = 1 - Distance
        similarity = 1.0 - distance if distance is not None else 0.0
        data["similarity"] = similarity
        matches.append(data)

    # Apply Filters in Python (Post-filtering)
    # This is safer than complex composite indexes for a prototype
    filtered_matches = [m for m in matches if m.get("source") == source]

    if author:
        filtered_matches = [
            m for m in filtered_matches if m.get("author") == author
        ]

    if start_date and end_date:
        try:
            start = datetime.datetime.fromisoformat(start_date)
            end = datetime.datetime.fromisoformat(end_date)
            # Convert string back to datetime for comparison if needed, or compare strings if ISO
            # data['created_at'] is now a string from _policy_to_dict
            filtered_matches = [
                m
                for m in filtered_matches
                if start
                <= datetime.datetime.fromisoformat(m["created_at"])
                <= end
            ]
        except Exception:
            pass  # Ignore date errors in filter

    if not filtered_matches:
        return {
            "status": "not_found",
            "message": "No policies found matching criteria after vector search.",
        }

    # Sort by similarity (descending)
    filtered_matches.sort(key=lambda x: x["similarity"], reverse=True)

    best_match = filtered_matches[0]

    # Update last_used
    try:
        doc_ref = (
            db.collection(COLLECTION_NAME)
            .where("policy_id", "==", best_match["policy_id"])
            .where("version", "==", best_match["version"])
            .limit(1)
            .get()
        )
        if doc_ref:
            doc_ref[0].reference.update({"last_used": datetime.datetime.now()})
    except Exception:
        pass  # Non-critical update

    return {
        "status": "found",
        "similarity": best_match["similarity"],
        "policy": best_match,
    }


def save_policy_to_memory(
    natural_language_query: str,
    policy_code: str,
    source: str,
    author: str = "user",
    policy_id: str | None = None,
) -> dict:
    """
    Saves a new policy or a new version of an existing policy to Firestore.
    """
    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    now = datetime.datetime.now()
    embedding_list = _get_embedding(natural_language_query)

    if not embedding_list:
        return {
            "status": "error",
            "message": "Could not generate embedding for policy.",
        }

    new_version = 1

    if policy_id:
        # Check for existing versions
        existing_versions = list(
            db.collection(COLLECTION_NAME)
            .where("policy_id", "==", policy_id)
            .stream()
        )
        if existing_versions:
            versions = [
                d.get("version") for d in existing_versions if d.get("version")
            ]
            if versions:
                new_version = max(versions) + 1
        else:
            # Provided ID but not found? Treat as new or error? Let's treat as new with that ID.
            pass
    else:
        policy_id = str(uuid.uuid4())

    doc_data = {
        "policy_id": policy_id,
        "version": new_version,
        "query": natural_language_query,
        "embedding": Vector(embedding_list),
        "code": policy_code,
        "source": source,
        "author": author,
        "last_used": now,
        "created_at": now,
        "ratings": [],
        "feedback": [],
    }

    try:
        # Use a new document for each version
        db.collection(COLLECTION_NAME).add(doc_data)
        return {
            "status": "success",
            "message": f"Policy saved as version {new_version} with ID {policy_id}.",
            "policy_id": policy_id,
            "version": new_version,
        }
    except Exception as e:
        return {"status": "error", "message": f"Failed to save policy: {e}"}


def list_policy_versions(policy_id: str) -> dict:
    """Lists all available versions for a given policy ID from Firestore."""
    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    try:
        docs = (
            db.collection(COLLECTION_NAME)
            .where("policy_id", "==", policy_id)
            .stream()
        )
        versions = []
        for doc in docs:
            versions.append(_policy_to_dict(doc))

        if not versions:
            return {
                "status": "not_found",
                "message": f"No policy found with ID '{policy_id}'.",
            }

        versions.sort(key=lambda p: p["version"], reverse=True)
        return {"status": "success", "versions": versions}
    except Exception as e:
        return {"status": "error", "message": f"Error listing versions: {e}"}


def get_policy_by_id(policy_id: str, version: int) -> dict:
    """Retrieves a specific version of a policy by its ID from Firestore."""
    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    try:
        docs = list(
            db.collection(COLLECTION_NAME)
            .where("policy_id", "==", policy_id)
            .where("version", "==", int(version))
            .limit(1)
            .stream()
        )

        if not docs:
            return {
                "status": "not_found",
                "message": f"Policy with ID '{policy_id}' and version '{version}' not found.",
            }

        policy = _policy_to_dict(docs[0])

        # Update last_used
        docs[0].reference.update({"last_used": datetime.datetime.now()})

        return {"status": "success", "policy": policy}

    except Exception as e:
        return {"status": "error", "message": f"Error retrieving policy: {e}"}


def prune_memory(days_to_keep: int = 30) -> dict:
    """Removes policies that have not been used in the last `days_to_keep` days."""
    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    cutoff_date = datetime.datetime.now() - datetime.timedelta(
        days=days_to_keep
    )

    try:
        # Query for policies accessed before the cutoff
        # Note: Requires an index on 'last_used'
        docs = (
            db.collection(COLLECTION_NAME)
            .where("last_used", "<", cutoff_date)
            .stream()
        )

        deleted_count = 0
        batch = db.batch()

        for doc in docs:
            batch.delete(doc.reference)
            deleted_count += 1
            if deleted_count % 400 == 0:  # Commit batches of 400
                batch.commit()
                batch = db.batch()

        if deleted_count % 400 != 0:
            batch.commit()

        return {
            "status": "success",
            "message": f"Pruned {deleted_count} old policies.",
        }
    except Exception as e:
        return {"status": "error", "message": f"Error pruning memory: {e}"}


def rate_policy(
    policy_id: str, version: int, rating: int, feedback: str | None = None
) -> dict:
    """Rates a policy and adds feedback in Firestore."""
    max_rating = 5

    if not 1 <= rating <= max_rating:
        return {
            "status": "error",
            "message": f"Rating must be between 1 and {max_rating}.",
        }

    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    try:
        docs = list(
            db.collection(COLLECTION_NAME)
            .where("policy_id", "==", policy_id)
            .where("version", "==", int(version))
            .limit(1)
            .stream()
        )

        if not docs:
            return {
                "status": "not_found",
                "message": f"Policy with ID '{policy_id}' and version '{version}' not found.",
            }

        doc_ref = docs[0].reference

        # Atomically update arrays
        updates = {"ratings": firestore.ArrayUnion([rating])}
        if feedback:
            updates["feedback"] = firestore.ArrayUnion([feedback])

        doc_ref.update(updates)

        return {"status": "success", "message": "Thank you for your feedback!"}

    except Exception as e:
        return {"status": "error", "message": f"Error submitting rating: {e}"}


def log_policy_execution(
    policy_id: str,
    version: int,
    status: str,
    source: str,
    violations: list[dict[str, Any]] | None = None,
    summary: str = "",
) -> dict:
    """
    Logs the execution of a policy to Firestore and updates aggregate stats.

    Args:
        violations: A list of violation objects. If provided, 'violation_count' and 'violated_resources' will be extracted.
    """
    if not db:
        return {
            "status": "success",
            "message": "Memory bank disabled. Execution not logged.",
        }

    now = datetime.datetime.now()

    violation_count = len(violations) if violations else 0

    # Extract unique violated resources
    violated_resources = set()
    if violations:
        for v in violations:
            # Extract resource identifier from common fields, with fallback
            res_name = (
                v.get("resource_name")
                or v.get("table_name")
                or v.get("asset_name")
                or v.get("dataset_name")
            )
            if res_name:
                violated_resources.add(str(res_name))

    # 1. Create Execution Log
    execution_data = {
        "policy_id": policy_id,
        "version": version,
        "timestamp": now,
        "status": status,  # 'success', 'failure', 'violations_found'
        "violation_count": violation_count,
        "source": source,
        "summary": summary,
        "violated_resources": list(
            violated_resources
        ),  # Store as array for querying
    }

    try:
        # Add to 'policy_executions' collection
        db.collection(FIRESTORE_COLLECTION_EXECUTIONS).add(execution_data)

        # 2. Update Aggregate Stats on Policy Document
        # Find the specific policy version document to update
        docs = list(
            db.collection(COLLECTION_NAME)
            .where("policy_id", "==", policy_id)
            .where("version", "==", int(version))
            .limit(1)
            .stream()
        )

        if docs:
            doc_ref = docs[0].reference
            updates = {"total_runs": firestore.Increment(1), "last_run": now}

            if status == "violations_found":
                updates["total_violations_detected"] = firestore.Increment(
                    violation_count
                )

            if status == "failure":
                updates["last_failure"] = now

            doc_ref.update(updates)

        return {"status": "success", "message": "Execution logged."}

    except Exception as e:
        logging.error(f"Failed to log execution: {e}")
        return {"status": "error", "message": f"Failed to log execution: {e}"}


def analyze_execution_history(
    query_type: str = "summary",
    days: int = 30,
    resource_name: str | None = None,
) -> dict:
    """
    Performs advanced analysis on policy execution history.

    Args:
        query_type: Type of analysis: 'summary', 'top_violations', 'resource_search', 'top_violated_resources'.
        days: Number of past days to analyze.
        resource_name: (For 'resource_search') The name of the resource to check.
    """
    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    # Ensure cutoff_date is timezone-aware (UTC) to match Firestore timestamps
    cutoff_date = datetime.datetime.now(datetime.UTC) - datetime.timedelta(
        days=days
    )

    try:
        if query_type == "resource_search":
            if not resource_name:
                return {
                    "status": "error",
                    "message": "resource_name is required for resource_search.",
                }

            # Search strategy: Fetch recent logs and perform case-insensitive substring matching in Python.
            # Firestore 'array-contains' requires exact matches, which doesn't support partial names
            # (e.g. 'quarterly_earnings' wouldn't find 'project.dataset.quarterly_earnings').

            query = db.collection(FIRESTORE_COLLECTION_EXECUTIONS).where(
                "timestamp", ">=", cutoff_date
            )
            # Order by timestamp descending for efficiency
            query = query.order_by(
                "timestamp", direction=firestore.Query.DESCENDING
            )

            results = query.stream()

            matches = []
            resource_name_lower = resource_name.lower()

            for doc in results:
                data = doc.to_dict()
                violated_resources = data.get("violated_resources", [])

                # Skip records with no violations recorded
                if not violated_resources:
                    continue

                # Check if any violated resource string contains the search term
                # We use a generator expression for efficiency
                if any(
                    resource_name_lower in str(r).lower()
                    for r in violated_resources
                ):
                    if "timestamp" in data and isinstance(
                        data["timestamp"], datetime.datetime
                    ):
                        data["timestamp"] = data["timestamp"].isoformat()
                    matches.append(data)

            matches.sort(key=lambda x: x.get("timestamp", ""), reverse=True)

            # Enrich matches with policy query
            policy_cache = {}

            for m in matches:
                pid = m.get("policy_id")
                ver = m.get("version")
                if not pid or ver is None:
                    continue

                cache_key = (pid, ver)
                if cache_key not in policy_cache:
                    # Fetch policy to get the natural language query
                    try:
                        docs = list(
                            db.collection(COLLECTION_NAME)
                            .where("policy_id", "==", pid)
                            .where("version", "==", int(ver))
                            .limit(1)
                            .stream()
                        )
                        if docs:
                            policy_cache[cache_key] = (
                                docs[0].to_dict().get("query")
                            )
                        else:
                            policy_cache[cache_key] = None
                    except Exception:
                        policy_cache[cache_key] = None

                if policy_cache[cache_key]:
                    m["policy_query"] = policy_cache[cache_key]

            return {"status": "success", "data": matches}

        elif query_type == "top_violations":
            # Aggregate total violations by policy from the *policies* collection (pre-aggregated)
            # or aggregate from execution logs?
            # Pre-aggregated on 'policies' doc is faster.

            # We scan policies that have been used/updated recently? Or all?
            # Let's scan all policies, sort by total_violations_detected desc.
            query = (
                db.collection(COLLECTION_NAME)
                .order_by(
                    "total_violations_detected",
                    direction=firestore.Query.DESCENDING,
                )
                .limit(10)
            )
            results = query.stream()

            top_policies = []
            for doc in results:
                p = _policy_to_dict(doc)
                if p.get("total_violations_detected", 0) > 0:
                    top_policies.append(
                        {
                            "policy_id": p.get("policy_id"),
                            "query": p.get("query"),
                            "total_violations": p.get(
                                "total_violations_detected"
                            ),
                            "last_run": p.get("last_run"),
                        }
                    )

            return {"status": "success", "data": top_policies}

        elif query_type == "top_violated_resources":
            # Scan executions for last X days to count resource violations
            query = db.collection(FIRESTORE_COLLECTION_EXECUTIONS).where(
                "timestamp", ">=", cutoff_date
            )
            results = query.stream()

            resource_counts = {}

            for doc in results:
                data = doc.to_dict()
                # List of resources that violated the policy in this execution
                violated_resources = data.get("violated_resources", [])

                for res in violated_resources:
                    res_str = str(res)
                    resource_counts[res_str] = (
                        resource_counts.get(res_str, 0) + 1
                    )

            # Sort by count descending
            sorted_resources = sorted(
                resource_counts.items(), key=lambda item: item[1], reverse=True
            )

            # Format top 10
            top_resources = [
                {"resource_name": r[0], "total_violations": r[1]}
                for r in sorted_resources[:10]
            ]

            return {"status": "success", "data": top_resources}

        else:  # "summary" or default
            # Returns a daily count of executions and violations
            # Scan executions for last X days
            query = db.collection(FIRESTORE_COLLECTION_EXECUTIONS).where(
                "timestamp", ">=", cutoff_date
            )
            results = query.stream()

            daily_stats = {}

            for doc in results:
                data = doc.to_dict()
                ts = data.get("timestamp")
                if not ts:
                    continue

                day_str = ts.strftime("%Y-%m-%d")
                if day_str not in daily_stats:
                    daily_stats[day_str] = {
                        "executions": 0,
                        "violations_detected": 0,
                    }

                daily_stats[day_str]["executions"] += 1
                daily_stats[day_str]["violations_detected"] += data.get(
                    "violation_count", 0
                )

            return {"status": "success", "data": daily_stats}

    except Exception as e:
        return {"status": "error", "message": f"Analysis failed: {e}"}


def get_execution_history(
    days: int = 7, status: str | None = None, policy_id: str | None = None
) -> dict:
    """
    Retrieves policy execution history from Firestore.

    Args:
        days: Number of past days to retrieve (default 7).
        status: Filter by status ('success', 'failure', 'violations_found').
        policy_id: Filter by a specific policy ID.
    """
    if not db:
        return {
            "status": "error",
            "message": "Memory bank is disabled. To enable long-term procedural memory, set ENABLE_MEMORY_BANK=True in .env and configure Firestore. See docs/MEMORY_INTEGRATION.md for details.",
        }

    # Ensure cutoff_date is timezone-aware (UTC) to match Firestore timestamps
    cutoff_date = datetime.datetime.now(datetime.UTC) - datetime.timedelta(
        days=days
    )

    try:
        # Query only by timestamp to utilize the default single-field index.
        # Composite filters (e.g., timestamp + status) require custom indexes in Firestore.
        # To maintain "out-of-the-box" usability without manual console setup,
        # we retrieve the recent history and filter in-memory.
        query = db.collection(FIRESTORE_COLLECTION_EXECUTIONS).where(
            "timestamp", ">=", cutoff_date
        )

        # Order by timestamp descending
        query = query.order_by(
            "timestamp", direction=firestore.Query.DESCENDING
        )

        results = query.stream()
        history = []

        for doc in results:
            data = doc.to_dict()

            # In-memory filtering
            if status and data.get("status") != status:
                continue

            if policy_id and data.get("policy_id") != policy_id:
                continue

            # Serialize timestamp
            if "timestamp" in data:
                data["timestamp"] = data["timestamp"].isoformat()
            history.append(data)

        if not history:
            return {
                "status": "success",
                "history": [],
                "message": "No execution history found for this criteria.",
            }

        return {"status": "success", "history": history}

    except Exception as e:
        return {"status": "error", "message": f"Error retrieving history: {e}"}
