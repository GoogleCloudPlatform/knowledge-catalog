"""Utility functions for the Knowledge Catalog Discovery Agent."""

import os


def get_consumer_project() -> str:
  """Extracts the consumer project from the environment variable.

  Returns:
      The consumer project ID.

  Raises:
      ValueError: If the GOOGLE_CLOUD_PROJECT environment variable is not set.
  """
  consumer_project = os.environ.get("GOOGLE_CLOUD_PROJECT")

  if not consumer_project:
    raise ValueError("GOOGLE_CLOUD_PROJECT environment variable is required.")

  return consumer_project


def get_knowledge_base_entry_group() -> str:
  """Extracts the knowledge base entry group from the environment variable.

  Returns:
      The knowledge base entry group resource name or an empty string if not set.
  """
  return os.environ.get("KNOWLEDGE_BASE_ENTRY_GROUP", "")