import logging
import threading
from typing import Any

import pandas as pd
from google import genai
from google.adk.plugins.base_plugin import BasePlugin
from google.cloud import bigquery
from google.genai import types

from .context import get_credentials
from .document_rag_engine import DocumentRAGEngine

logger = logging.getLogger(__name__)


class DocDescriptionPlugin(BasePlugin):
    def __init__(self, project_id: str, location: str = "europe-west1"):
        super().__init__(name="doc_description_plugin")
        self.project_id = project_id
        self.location = location
        self._bq_client = None
        self._rag_engine = None
        self._client = None
        self._lock = threading.Lock()
        self._thread_local = threading.local()

    def _ensure_initialized(self):
        if not self._bq_client or not self._rag_engine or not self._client:
            with self._lock:
                creds = get_credentials(self.project_id)
                if not self._bq_client:
                    self._bq_client = bigquery.Client(
                        project=self.project_id, credentials=creds
                    )
                if not self._rag_engine:
                    self._rag_engine = DocumentRAGEngine(
                        self.project_id,
                        location=self.location,
                        credentials=creds,
                    )
                if not self._client:
                    self._client = genai.Client(
                        project=self.project_id,
                        location=self.location,
                        credentials=creds,
                        vertexai=True,
                    )

    def load_document(
        self,
        doc_path: list[str] | None,
        mode: str = "rag",
        datastore_id: str | None = None,
        force_refresh: bool = False,
    ):
        """Loads the document(s) or sets up the DataStore."""
        self._ensure_initialized()
        self.mode = mode
        self.datastore_id = datastore_id

        if not doc_path:
            return

        import os

        for path in doc_path:
            if not os.path.exists(path):
                raise FileNotFoundError(f"Document file not found: '{path}'")

        if self.mode == "rag":
            self._rag_engine.load_documents_parallel(
                doc_path, force_refresh=force_refresh
            )
        elif self.mode == "direct":
            self.full_text = ""
            import os
            from concurrent.futures import ThreadPoolExecutor

            def _read_or_extract(path: str) -> str:
                ext = os.path.splitext(path)[1].lower()
                if ext in [".txt", ".md"]:
                    with open(path, encoding="utf-8") as f:
                        return f.read()
                elif ext in [".pdf", ".xlsx", ".png", ".jpg", ".jpeg"]:
                    return self._rag_engine._extract_text_via_gemini(
                        path, force_refresh=force_refresh
                    )
                elif ext == ".docx":
                    raise ValueError(
                        "DOCX files are not supported directly by Gemini in this setup. Please convert to PDF or TXT first."
                    )
                return ""

            with ThreadPoolExecutor(max_workers=min(len(doc_path), 5)) as executor:
                extracted_texts = list(executor.map(_read_or_extract, doc_path))

            for content in extracted_texts:
                if content and content.strip():
                    self.full_text += content + "\n"

        elif self.mode == "datastore" and datastore_id:
            # Fail Fast: Verify DataStore exists
            logger.info(f"Verifying DataStore '{datastore_id}'...")
            if not self._verify_datastore_exists():
                raise ValueError(
                    f"DataStore '{datastore_id}' not found or not accessible."
                )

    def pre_embed_column_queries(
        self, table_id: str, columns: list[tuple[str, str]]
    ) -> None:
        """Pre-embeds and caches queries for all columns in batch if RAG mode is used."""
        self._ensure_initialized()
        if self.mode == "rag" and self._rag_engine:
            queries = []
            for col_name, col_type in columns:
                # Add strict query
                queries.append(
                    f"Table: {table_id}, Column: {col_name} ({col_type})"
                )
                # Add fallback query
                queries.append(f"Table: {table_id}")
            self._rag_engine.pre_embed_queries(queries)

    def recommend_description_for_column(
        self,
        table_id: str,
        col_name: str,
        col_type: str,
        fallback: bool = False,
    ) -> dict[str, Any] | None:
        """Recommends a description for a single column based on selected mode."""
        self._ensure_initialized()

        logger.info(
            f"Analyzing column '{col_name}' in table '{table_id}' using mode '{self.mode}'..."
        )

        query = f"Table: {table_id}, Column: {col_name} ({col_type})"
        context = ""
        top_score = 0.8  # Default fallback

        if self.mode == "rag":
            if fallback:
                # Retrieve broader table-level context for fallback inference
                table_query = f"Table: {table_id}"
                chunks = self._rag_engine.retrieve(table_query, top_k=8)
            else:
                chunks = self._rag_engine.retrieve(query, top_k=5)
            if chunks:
                context = "\n---\n".join([c["text"] for c in chunks])
                top_score = chunks[0]["score"]  # Use top similarity score

        elif self.mode == "direct":
            if hasattr(self, "full_text") and self.full_text:
                context = self.full_text

        elif self.mode == "datastore":
            if self.datastore_id:
                if fallback:
                    table_query = f"Table: {table_id}"
                    context = self._query_datastore(table_query)
                else:
                    context = self._query_datastore(query)

        desc = ""
        if not fallback and context and context.strip():
            # Generate description via Gemini
            desc = self._generate_description_with_context(
                table_id, col_name, col_type, context
            )

        if desc:
            return {
                "Target Column": col_name,
                "Proposed Description": desc,
                "Confidence": round(top_score, 2),  # Round to 2 decimals
                "Source": f"Document ({self.mode})",
                "Rationale": f"Generated using {self.mode} document processing",
            }

        if fallback:
            # Generate fallback description (uses document context for inference if available)
            fallback_desc = self._generate_fallback_description(
                table_id, col_name, col_type, context
            )
            if fallback_desc:
                return {
                    "Target Column": col_name,
                    "Proposed Description": fallback_desc,
                    "Confidence": 0.7 if (context and context.strip()) else 0.5,
                    "Source": f"Fallback ({self.mode})"
                    if (context and context.strip())
                    else "Fallback (LLM)",
                    "Rationale": "Generated description using table context from document as fallback"
                    if (context and context.strip())
                    else "Generated description based on column name and type as fallback",
                }

        return None

    def recommend_policy_tag_for_column(
        self,
        table_id: str,
        col_name: str,
        col_type: str,
        allowed_tags: list[str],
    ) -> dict[str, Any] | None:
        """Recommends a policy tag for a single column based on selected mode (Strict Grounding)."""
        self._ensure_initialized()

        logger.info(
            f"Analyzing Policy Tag for column '{col_name}' in table '{table_id}' using mode '{self.mode}'..."
        )

        query = f"Table: {table_id}, Column: {col_name} ({col_type})"
        context = ""
        top_score = 0.8  # Default fallback

        if self.mode == "rag":
            chunks = self._rag_engine.retrieve(query, top_k=5)
            if chunks:
                context = "\n---\n".join([c["text"] for c in chunks])
                top_score = chunks[0]["score"]

        elif self.mode == "direct":
            if hasattr(self, "full_text") and self.full_text:
                context = self.full_text

        elif self.mode == "datastore":
            if self.datastore_id:
                context = self._query_datastore(query)

        if not context or not context.strip():
            return None

        # Generate Policy Tag recommendation via Gemini
        tag = self._generate_policy_tag_with_context(
            table_id, col_name, col_type, context, allowed_tags
        )

        if tag and tag != "NO_INFO":
            return {
                "Target Column": col_name,
                "Proposed Tag": tag,
                "Confidence": round(top_score, 2),
                "Source": f"Document ({self.mode})",
                "Rationale": f"Extracted explicit tag from {self.mode} document processing",
            }
        return None

    def recommend_glossary_terms_for_column(
        self,
        table_id: str,
        col_name: str,
        col_type: str,
        allowed_terms: list[str],
    ) -> dict[str, Any] | None:
        """Recommends a glossary term for a single column based on selected mode (Strict Grounding)."""
        self._ensure_initialized()

        logger.info(
            f"Analyzing Glossary Term for column '{col_name}' in table '{table_id}' using mode '{self.mode}'..."
        )

        query = f"Table: {table_id}, Column: {col_name} ({col_type})"
        context = ""
        top_score = 0.8  # Default fallback

        if self.mode == "rag":
            chunks = self._rag_engine.retrieve(query, top_k=5)
            if chunks:
                context = "\n---\n".join([c["text"] for c in chunks])
                top_score = chunks[0]["score"]

        elif self.mode == "direct":
            if hasattr(self, "full_text") and self.full_text:
                context = self.full_text

        elif self.mode == "datastore":
            if self.datastore_id:
                context = self._query_datastore(query)

        if not context or not context.strip():
            return None

        # Generate Glossary Term recommendation via Gemini
        term = self._generate_glossary_term_with_context(
            table_id, col_name, col_type, context, allowed_terms
        )

        if term and term != "NO_INFO":
            return {
                "Target Column": col_name,
                "Proposed Term": term,
                "Confidence": round(top_score, 2),
                "Source": f"Document ({self.mode})",
                "Rationale": f"Extracted explicit glossary term from {self.mode} document processing",
            }
        return None

    def _query_datastore(self, query: str) -> str:
        """Queries the Vertex AI Search DataStore using REST API."""
        import google.auth
        from google.auth.transport.requests import AuthorizedSession

        project_id = self.project_id
        location = "global"
        datastore_id = self.datastore_id

        # Use thread-local storage for session to reuse connections
        if not hasattr(self._thread_local, "session"):
            credentials = get_credentials(self.project_id)
            self._thread_local.session = AuthorizedSession(credentials)

        authed_session = self._thread_local.session

        # Handle full resource path vs short ID
        if datastore_id.startswith("projects/"):
            url = f"https://discoveryengine.googleapis.com/v1/{datastore_id}/servingConfigs/default_search:search"
        else:
            url = f"https://discoveryengine.googleapis.com/v1/projects/{project_id}/locations/{location}/collections/default_collection/dataStores/{datastore_id}/servingConfigs/default_search:search"

        payload = {
            "query": query,
            "pageSize": 10,  # Increase page size to get more snippets across results
            "contentSearchSpec": {"snippetSpec": {"maxSnippetCount": 3}},
        }

        try:
            response = authed_session.post(url, json=payload)
            if response.status_code == 200:
                data = response.json()
                results = data.get("results", [])
                snippets = []
                for result in results:
                    doc = result.get("document", {})
                    derived_data = doc.get("derivedStructData", {})
                    # Look for extractive segments first, fallback to snippets
                    segments = derived_data.get("extractive_segments", [])
                    if segments:
                        for s in segments:
                            snippets.append(s.get("content"))
                    else:
                        doc_snippets = derived_data.get("snippets", [])
                        for s in doc_snippets:
                            snippets.append(s.get("snippet"))

                # Move to debug logs
                logger.debug(
                    f"DataStore retrieved {len(snippets)} snippets for query: '{query}'"
                )
                for i, s in enumerate(snippets):
                    logger.debug(f"  Snippet {i + 1}: {s}")
                return "\n---\n".join(snippets)
            else:
                try:
                    err_data = response.json()
                    msg = err_data.get("error", {}).get(
                        "message", response.text
                    )
                    logger.error(f"DataStore search failed: {msg}")
                except Exception:
                    logger.error(
                        f"DataStore search failed with status {response.status_code}"
                    )
                return ""
        except Exception as e:
            logger.error(f"Exception querying DataStore: {e}")
            return ""

    def _verify_datastore_exists(self) -> bool:
        """Verifies that the DataStore exists by making a simple search call."""
        from google.auth.transport.requests import AuthorizedSession

        project_id = self.project_id
        location = "global"
        datastore_id = self.datastore_id

        credentials = get_credentials(self.project_id)
        authed_session = AuthorizedSession(credentials)

        if datastore_id.startswith("projects/"):
            url = f"https://discoveryengine.googleapis.com/v1/{datastore_id}/servingConfigs/default_search:search"
        else:
            url = f"https://discoveryengine.googleapis.com/v1/projects/{project_id}/locations/{location}/collections/default_collection/dataStores/{datastore_id}/servingConfigs/default_search:search"

        payload = {"query": "test", "pageSize": 1}

        try:
            response = authed_session.post(url, json=payload)
            if response.status_code == 200:
                return True
            elif response.status_code == 404:
                return False
            else:
                logger.warning(
                    f"DataStore verification returned status {response.status_code}"
                )
                return True  # Assume exists if not 404 for safety
        except Exception as e:
            logger.error(f"Exception verifying DataStore: {e}")
            return (
                True  # Assume exists to avoid false negatives on network issues
            )

    def recommend_descriptions(
        self, dataset_id: str, table_id: str, doc_path: str
    ) -> pd.DataFrame:
        """Recommends column descriptions based on unstructured document context (Batch)."""
        self._ensure_initialized()
        self.load_document(doc_path)

        table_ref = f"{self.project_id}.{dataset_id}.{table_id}"
        table = self._bq_client.get_table(table_ref)

        recommendations = []

        for field in table.schema:
            if field.description:
                continue

            rec = self.recommend_description_for_column(
                table_id, field.name, field.field_type
            )
            if rec:
                recommendations.append(rec)

        return pd.DataFrame(recommendations)

    def _generate_description_with_context(
        self, table_id: str, col_name: str, col_type: str, context: str
    ) -> str:
        """Calls Gemini to generate a description based on context with strict grounding."""
        if not context or not context.strip():
            logger.warning(f"No context found for column {col_name}")
            return ""

        prompt = f"""
You are a Data Steward. Your task is to generate a short, professional description for a database column based on the provided reference documentation.

Table Name: {table_id}
Column Name: {col_name}
Column Type: {col_type}

Reference Documentation:
{context}

CRITICAL RULES:
1. Scan the Reference Documentation specifically for table '{table_id}' and find where column '{col_name}' is listed/defined.
2. If '{col_name}' is NOT explicitly defined or listed under '{table_id}' in the documentation, you MUST reply with exactly "NO_INFO" and absolutely nothing else.
3. DO NOT infer, extrapolate, guess, or assume the description based on surrounding columns, other tables, or general knowledge. If it is not explicitly documented, output "NO_INFO".
4. If it IS explicitly documented, generate a concise description (1-2 sentences) of the column based ONLY on the provided text.
5. Your output must be either the column description OR exactly "NO_INFO". Do not include any preambles, explanations, or extra commentary.
"""
        logger.debug(f"Gemini Description Prompt:\n{prompt}")
        try:
            with self._lock:
                response = self._client.models.generate_content(
                    model="gemini-2.5-flash-lite",
                    contents=prompt,
                    config=types.GenerateContentConfig(temperature=0.0),
                )
            text = response.text.strip()
            logger.debug(f"Gemini Description Response:\n{text}")
            if text == "NO_INFO":
                return ""
            return text
        except Exception as e:
            logger.error(f"Failed to generate description for {col_name}: {e}")
            return ""

    def _generate_fallback_description(
        self,
        table_id: str,
        col_name: str,
        col_type: str,
        context: str | None = None,
    ) -> str:
        """Calls Gemini to generate a fallback description based on schema, with optional loose grounding on context."""
        if context and context.strip():
            prompt = f"""
You are a Data Steward. Your task is to generate a short, professional description for a database column.
We have some reference documentation for the table, but it might not contain an explicit definition for this specific column. 
You must generate the best possible description using the provided documentation as context. If the column is not explicitly defined, you should infer its meaning/purpose based on the table's overall purpose, the surrounding columns, or other context in the document.

Table Name: {table_id}
Column Name: {col_name}
Column Type: {col_type}

Reference Documentation:
{context}

Instructions:
1. Generate a concise, professional description (1-2 sentences) for the column.
2. Focus on the business meaning and purpose of the column in the context of this table.
3. Keep the description clear, factual, and helpful. Do not mention that it was inferred or that documentation was missing.
"""
        else:
            prompt = f"""
You are a Data Steward. Your task is to generate a short, professional description for a database column.
Since no reference documentation is available for this column, you must generate a description based on the column name, type, and table name.

Table Name: {table_id}
Column Name: {col_name}
Column Type: {col_type}

Instructions:
1. Generate a concise, professional description (1-2 sentences) for the column.
2. Focus on the typical business meaning and purpose of such a column in this context.
3. Keep the description clear, factual, and helpful. Do not mention that it is a fallback or that documentation was missing.
"""
        logger.debug(f"Gemini Fallback Description Prompt:\n{prompt}")
        try:
            with self._lock:
                response = self._client.models.generate_content(
                    model="gemini-2.5-flash-lite",
                    contents=prompt,
                    config=types.GenerateContentConfig(temperature=0.0),
                )
            text = response.text.strip()
            logger.debug(f"Gemini Fallback Description Response:\n{text}")
            return text
        except Exception as e:
            logger.error(
                f"Failed to generate fallback description for {col_name}: {e}"
            )
            return ""

    def _generate_policy_tag_with_context(
        self,
        table_id: str,
        col_name: str,
        col_type: str,
        context: str,
        allowed_tags: list[str],
    ) -> str:
        """Calls Gemini to extract policy tags based on context with strict grounding (no inference)."""
        if not context or not context.strip():
            logger.warning(f"No context found for column {col_name}")
            return ""

        tags_str = ", ".join([f"'{t}'" for t in allowed_tags])

        prompt = f"""
You are a Data Steward. Your task is to identify if a database column has an EXPLICIT policy tag or PII classification assigned to it in the provided reference documentation.

Table Name: {table_id}
Column Name: {col_name}
Column Type: {col_type}

Reference Documentation:
{context}

Instructions:
1. Look for explicit indicators of sensitivity, such as a column explicitly labeled "PII" with value "Y", or a dedicated "Policy Tags" section listing this column.
2. The documentation might contain information about OTHER tables. You MUST ignore information that does not pertain to the table '{table_id}'.
3. If the documentation does NOT explicitly label this column as PII or sensitive in the context of table '{table_id}', you MUST reply with "NO_INFO". 
4. Do NOT infer or guess that a column is PII based on its name (like "Full Name") or description. Only reply with a tag if the document EXPLICITLY states it.
5. You MUST ONLY choose a tag from this list of allowed tags: [{tags_str}].
6. Reply with ONLY the exact tag name from the list, or "NO_INFO".
"""
        logger.debug(f"Gemini Policy Tag Prompt:\n{prompt}")
        try:
            with self._lock:
                response = self._client.models.generate_content(
                    model="gemini-2.5-flash-lite",
                    contents=prompt,
                    config=types.GenerateContentConfig(temperature=0.0),
                )
            text = response.text.strip()
            logger.debug(f"Gemini Policy Tag Response:\n{text}")
            return text
        except Exception as e:
            logger.error(f"Failed to generate policy tag for {col_name}: {e}")
            return ""

    def _generate_glossary_term_with_context(
        self,
        table_id: str,
        col_name: str,
        col_type: str,
        context: str,
        allowed_terms: list[str],
    ) -> str:
        """Calls Gemini to extract glossary terms based on context with strict grounding."""
        if not context or not context.strip():
            logger.warning(f"No context found for column {col_name}")
            return ""

        terms_str = ", ".join([f"'{t}'" for t in allowed_terms])

        prompt = f"""
You are a Data Steward. Your task is to identify if a database column maps to a specific Business Glossary term based on the provided reference documentation.

Table Name: {table_id}
Column Name: {col_name}
Column Type: {col_type}

Reference Documentation:
{context}

Instructions:
1. Look for explicit statements mapping this column to a business concept or term in the allowed list.
2. The documentation might contain information about OTHER tables. You MUST ignore information that does not pertain to the table '{table_id}'.
3. If the documentation does not explicitly map this column to a term in the list in the context of table '{table_id}', you MUST reply with "NO_INFO".
4. Do NOT infer or guess that a column maps to a term based on its name or description unless the document EXPLICITLY states the mapping or definition that equates to the term.
5. You MUST ONLY choose a term from this list of allowed terms: [{terms_str}].
6. Reply with ONLY the exact term name from the list, or "NO_INFO".
"""
        logger.debug(f"Gemini Glossary Prompt:\n{prompt}")
        try:
            with self._lock:
                response = self._client.models.generate_content(
                    model="gemini-2.5-flash-lite",
                    contents=prompt,
                    config=types.GenerateContentConfig(temperature=0.0),
                )
            text = response.text.strip()
            logger.debug(f"Gemini Glossary Response:\n{text}")
            return text
        except Exception as e:
            logger.error(
                f"Failed to generate glossary term for {col_name}: {e}"
            )
            return ""
