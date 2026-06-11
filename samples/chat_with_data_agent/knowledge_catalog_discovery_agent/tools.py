"""A collection of tools used by the Knowledge Catalog Search Agent."""

import concurrent.futures
import logging
import os

import google.auth
from google.api_core import retry
from google.api_core.exceptions import PermissionDenied
from google.cloud import dataplex_v1

from .utils import get_consumer_project

MAX_WORKERS = 5


def _get_catalog_client() -> dataplex_v1.CatalogServiceClient:
  """Creates an authenticated CatalogServiceClient."""
  credentials, _ = google.auth.default(
      scopes=["https://www.googleapis.com/auth/cloud-platform"],
  )
  return dataplex_v1.CatalogServiceClient(
      credentials=credentials,
      client_options={
          "api_endpoint": "dataplex.googleapis.com",
      },
  )


TRANSIENT_RETRY = retry.Retry(
    predicate=retry.if_transient_error,
    initial=2.0,
    maximum=2.0,
    multiplier=1.0,
    timeout=9.0,
)


def _lookup_context(region: str, batch_entries: list[str]) -> str:
  """Calls LookupContext API via the Google Cloud Knowledge Catalog Python SDK."""
  try:
    consumer_project_id = get_consumer_project()
  except ValueError as e:
    return f"Error obtaining consumer project: {e}"

  try:
    client = _get_catalog_client()
    parent_name = f"projects/{consumer_project_id}/locations/{region}"
    request = dataplex_v1.LookupContextRequest(
        name=parent_name,
        resources=batch_entries,
    )
    logging.info(
        "Sending LookupContext request for parent %s with resources %s",
        parent_name,
        batch_entries,
    )
    response = client.lookup_context(request=request, retry=TRANSIENT_RETRY)
    return response.context
  except Exception as e:  # pylint: disable=broad-except
    logging.warning(
        "LookupContext failed for batch %s in %s: %s",
        batch_entries,
        region,
        e,
    )
    return f"Error retrieving context for {batch_entries}: {e}"



def _knowledge_catalog_search(
    query: str,
) -> dict[str, list[str] | str]:
  """Searches Knowledge Catalog using Semantic Search capabilities.

  Args:
      query: The natural language search query.

  Returns:
      A dictionary containing a list of entries along with their metadata
      or an error message. For example, {'results': [{'entry_name': 'entry1',
      'system': 'BIGQUERY', ...}]}.
  """
  try:
    consumer_project_id = get_consumer_project()
  except ValueError as e:
    return {"Error obtaining consumer project": str(e)}

  try:
    client = _get_catalog_client()

    parent_name = f"projects/{consumer_project_id}/locations/global"
    response = client.search_entries(
        request={
            "name": parent_name,
            "query": query,
            "page_size": 50,
            "semantic_search": True,
        },
        retry=TRANSIENT_RETRY,
    )

    entries = [
        {
            "entry_name": result.dataplex_entry.name,
            "system": result.dataplex_entry.entry_source.system,
            "resource_id": result.dataplex_entry.entry_source.resource,
            "display_name": result.dataplex_entry.entry_source.display_name,
        }
        for result in response.results
    ]

    return {"results": entries}

  except PermissionDenied as exc:
    logging.exception(
        "Knowledge Catalog search failed due to permission error when querying"
        " %s: %s",
        parent_name,
        exc,
    )
    return {
        "error": f"Permission denied when querying {parent_name}: {exc}"
    }
  except Exception as exc:  # pylint: disable=broad-except
    logging.exception(
        "An unexpected error occurred during Knowledge Catalog search when"
        " querying %s: %s",
        parent_name,
        exc,
    )
    return {"error": f"An unexpected error occurred when querying {parent_name}: {exc}"}


def knowledge_catalog_multi_search(
    queries: list[str],
) -> dict[str, list[dict[str, str]] | str]:
  """Performs multiple Knowledge Catalog searches in parallel and merges results.

  Uses a Round-Robin interleaving strategy to maintain original relevance
  rankings as much as possible while deduplicating results.
  Also fetches rich context using LookupContext API for the merged results.

  Args:
      queries: A list of natural language search queries. The order of queries
        influences the final result order.

  Returns:
      A dictionary containing a list of search results under the 'results' key,
      combined context under 'combined_context' key, or error messages.
  """
  if not queries:
    return {"results": []}

  page_size = 100
  query_results_list: list[list[dict[str, str]]] = []
  errors: list[str] = []


  with concurrent.futures.ThreadPoolExecutor(
      max_workers=MAX_WORKERS
  ) as executor:
    future_to_query = [
        executor.submit(_knowledge_catalog_search, q)
        for q in queries
    ]

    # Retrieve and process search results from each parallel execution, logging any issues
    for i, future in enumerate(future_to_query):
      query = queries[i]
      try:
        result = future.result()
        if "results" in result and isinstance(result["results"], list):
          query_results_list.append(result["results"])
        elif "error" in result:
          logging.warning("Error for query '%s': %s", query, result["error"])
          errors.append(str(result["error"]))
          query_results_list.append([])
        else:
          error_msg = next(iter(result.values())) if result else "Unknown error"
          logging.warning("Error for query '%s': %s", query, error_msg)
          errors.append(str(error_msg))
          query_results_list.append([])
      except Exception as exc:  # pylint: disable=broad-except
        logging.exception("Exception for query '%s': %s", query, exc)
        errors.append(f"Exception: {exc}")
        query_results_list.append([])

  if errors and len(errors) == len(queries):
    return {"error": "All search queries failed.", "details": errors}

  return _deduplicate_and_fetch_context(query_results_list, page_size)


def _deduplicate_and_fetch_context(
    query_results_list: list[list[dict[str, str]]],
    page_size: int = 100,
) -> dict[str, list[dict[str, str]] | str]:
  """Deduplicates query results using round-robin and retrieves context."""
  final_results = []
  seen_names = set()

  max_depth = max((len(res) for res in query_results_list), default=0)

  # Interleave and deduplicate results from different queries round-robin style to preserve relevance order
  for depth in range(max_depth):
    for result_set in query_results_list:
      if depth < len(result_set):
        item = result_set[depth]
        entry_name = item.get("entry_name")
        if entry_name and entry_name not in seen_names:
          final_results.append(item)
          seen_names.add(entry_name)
          if len(final_results) == page_size:
            break
    if len(final_results) == page_size:
      break

  # Group entries by GCP region
  entries_by_region = {}
  for item in final_results:
    entry_name = item["entry_name"]
    parts = entry_name.split("/")
    current_location = "global"
    if len(parts) >= 4 and parts[0] == "projects" and parts[2] == "locations":
      current_location = parts[3]

    if current_location not in entries_by_region:
      entries_by_region[current_location] = []
    entries_by_region[current_location].append(entry_name)

  # Partition entries into regional batches of maximum size 10
  batches = []
  for region, items in entries_by_region.items():
    for i in range(0, len(items), 10):
      batches.append((region, items[i : i + 10]))

  lookup_context_max_workers = 2
  # Fetch context concurrently for each regional batch using ThreadPoolExecutor
  with concurrent.futures.ThreadPoolExecutor(
      max_workers=lookup_context_max_workers
  ) as executor:
    futures = [
        executor.submit(_lookup_context, region, batch)
        for region, batch in batches
    ]
    concurrent.futures.wait(futures)
    regional_contexts = [f.result() for f in futures]

  # Combine and return regional contexts along with the final deduplicated results
  combined_context = "\n\n".join(filter(None, regional_contexts))

  return {
      "results": final_results,
      "combined_context": combined_context,
  }

