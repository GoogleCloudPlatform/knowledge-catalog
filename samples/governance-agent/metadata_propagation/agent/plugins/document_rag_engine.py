import logging
import os
import tempfile
import time
from typing import Any

from google import genai
from google.genai import types

from .context import get_credentials
from .vertex_embedder import VertexAIEmbedder

logger = logging.getLogger(__name__)

EXTRACTION_PROMPT = (
    "Analyze this document (which may be a raw file representation, image, PDF, or text representation of a spreadsheet) "
    "and extract ONLY the information relevant to data governance, table definitions, column descriptions, "
    "business glossary terms, and data classification/policy tags. "
    "Ignore all other unrelated information (such as infrastructure setup, deployment steps, project background, cafeteria menus, administrative instructions, etc.). "
    "Format the extracted information as clean Markdown using the following rules:\n"
    "1. Use `# Table: [Name]` as the header for a table section.\n"
    "2. Use `# Business Glossary for Table: [Name]` for glossary terms belonging to that table.\n"
    "3. Use `# Policy Tags for Table: [Name]` for classification rules belonging to that table.\n"
    "Use bold text for sub-sections (e.g., **Column Definitions**). "
    "Do not summarize the content, just extract the relevant parts accurately."
)


class DocumentRAGEngine:
    def __init__(
        self,
        project_id: str,
        location: str = "us-central1",
        credentials: Any | None = None,
    ):
        self.project_id = project_id
        self.location = location
        self._credentials = credentials or get_credentials(project_id)
        self.embedder = VertexAIEmbedder(
            project_id, location, credentials=self._credentials
        )
        self.chunks = []
        self.embeddings = []
        self._client = None
        self._query_embeddings_cache = {}

    def _get_client(self):
        if self._client is None:
            try:
                self._client = genai.Client(
                    project=self.project_id,
                    location=self.location,
                    credentials=self._credentials,
                    vertexai=True,
                )
            except Exception as e:
                logger.error(f"Failed to initialize GenAI Client: {e}")
        return self._client

    def load_documents_parallel(
        self,
        file_paths: list[str],
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        force_refresh: bool = False,
    ):
        """Loads and extracts multiple documents concurrently in parallel."""
        if not file_paths:
            return

        if len(file_paths) == 1:
            self.load_document(
                file_paths[0],
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                force_refresh=force_refresh,
            )
            return

        from concurrent.futures import ThreadPoolExecutor

        logger.info(
            f"Extracting {len(file_paths)} documents in parallel via ThreadPoolExecutor..."
        )

        def _extract_single(path: str) -> tuple[str, str]:
            ext = os.path.splitext(path)[1].lower()
            if ext in [".txt", ".pdf", ".md", ".xlsx", ".png", ".jpg", ".jpeg"]:
                return path, self._extract_text_via_gemini(
                    path, force_refresh=force_refresh
                )
            elif ext == ".docx":
                raise ValueError(
                    "DOCX files are not supported directly by Gemini in this setup. Please convert to PDF or TXT first."
                )
            else:
                raise ValueError(f"Unsupported file extension: {ext}")

        all_new_chunks = []
        with ThreadPoolExecutor(max_workers=min(len(file_paths), 5)) as executor:
            extracted_results = list(executor.map(_extract_single, file_paths))

        for path, text in extracted_results:
            if not text:
                logger.error(f"No text extracted from document: {path}")
                continue
            new_chunks = self._chunk_text(text, chunk_size, chunk_overlap)
            all_new_chunks.extend(new_chunks)
            logger.info(
                f"Created {len(new_chunks)} chunks from document '{os.path.basename(path)}'."
            )

        self.chunks.extend(all_new_chunks)
        if all_new_chunks:
            logger.info(
                f"Generating embeddings for {len(all_new_chunks)} total chunks..."
            )
            new_embeddings = self.embedder.get_embeddings(
                all_new_chunks, task_type="RETRIEVAL_DOCUMENT"
            )
            self.embeddings.extend(new_embeddings)
            logger.info("Embeddings generated successfully.")

    def load_document(
        self, file_path: str, chunk_size: int = 1000, chunk_overlap: int = 200, force_refresh: bool = False
    ):
        """Loads a document (PDF or TXT), extracts text, chunks it, and generates embeddings."""
        logger.info(f"Loading document from {file_path}")

        text = ""
        ext = os.path.splitext(file_path)[1].lower()

        if ext in [".txt", ".pdf", ".md", ".xlsx", ".png", ".jpg", ".jpeg"]:
            text = self._extract_text_via_gemini(file_path, force_refresh=force_refresh)
        elif ext == ".docx":
            raise ValueError(
                "DOCX files are not supported directly by Gemini in this setup. Please convert to PDF or TXT first."
            )
        else:
            raise ValueError(f"Unsupported file extension: {ext}")

        if not text:
            logger.error("No text extracted from document.")
            return

        # 2. Chunk text
        new_chunks = self._chunk_text(text, chunk_size, chunk_overlap)
        self.chunks.extend(new_chunks)
        logger.info(f"Created {len(new_chunks)} chunks from document.")

        # Move to debug logs
        logger.debug(f"Created {len(new_chunks)} chunks")
        for i, chunk in enumerate(new_chunks):
            logger.debug(f"--- Chunk {i + 1} ---")
            logger.debug(chunk)
            logger.debug("-" * 20)

        # 3. Generate embeddings
        if new_chunks:
            logger.info("Generating embeddings for chunks...")
            new_embeddings = self.embedder.get_embeddings(
                new_chunks, task_type="RETRIEVAL_DOCUMENT"
            )
            self.embeddings.extend(new_embeddings)
            logger.info("Embeddings generated successfully.")

    def _extract_text_via_gemini(self, file_path: str, force_refresh: bool = False) -> str:
        """Uses Gemini to extract text and format as Markdown, with hash-based caching."""
        import hashlib
        import re

        try:
            with open(file_path, "rb") as f:
                file_bytes = f.read()
        except Exception as e:
            logger.error(f"Failed to read file: {e}")
            return ""

        # Calculate hash
        file_hash = hashlib.md5(file_bytes).hexdigest()

        # Cache directory in system temp directory (/tmp/governance_agent_rag_cache)
        cache_dir = os.path.join(tempfile.gettempdir(), "governance_agent_rag_cache")
        os.makedirs(cache_dir, exist_ok=True)

        # Automated TTL purge: remove cached files older than 30 days
        now_ts = time.time()
        ttl_sec = 30 * 86400
        for c_file in os.listdir(cache_dir):
            c_path = os.path.join(cache_dir, c_file)
            if os.path.isfile(c_path):
                try:
                    if now_ts - os.path.getmtime(c_path) > ttl_sec:
                        os.remove(c_path)
                        logger.debug(f"Purged expired RAG cache file (> 30 days old): {c_path}")
                except Exception:
                    pass

        raw_base = os.path.basename(file_path)
        clean_base = re.sub(r"^[0-9a-f]{8}_", "", raw_base)
        cached_path = os.path.join(cache_dir, f"{clean_base}.{file_hash}.md")

        # Check clean_base cache path or any existing cache file with the same MD5 hash
        if not force_refresh:
            if os.path.exists(cached_path):
                logger.info(f"Found cached Markdown file: {cached_path}")
                with open(cached_path, encoding="utf-8") as f:
                    return f.read()
            # Also check if any file ending with .{file_hash}.md exists in cache_dir
            for c_file in os.listdir(cache_dir):
                if c_file.endswith(f".{file_hash}.md"):
                    found_c_path = os.path.join(cache_dir, c_file)
                    logger.info(f"Found cached Markdown file by hash: {found_c_path}")
                    with open(found_c_path, encoding="utf-8") as f:
                        return f.read()

        logger.info(
            f"Extracting structured governance data via Gemini: {file_path}"
        )
        client = self._get_client()
        if not client:
            return ""

        try:
            ext = os.path.splitext(file_path)[1].lower()

            # Special case for .xlsx: Parse locally to text and send as text/plain
            if ext == ".xlsx":
                xlsx_text = self._convert_xlsx_to_text(file_path)
                if not xlsx_text:
                    return ""

                content_parts = [xlsx_text, EXTRACTION_PROMPT]
            else:
                # Standard binary/multimodal or plain text files
                if ext == ".pdf":
                    mime_type = "application/pdf"
                elif ext in [".txt", ".md"]:
                    mime_type = "text/plain"
                elif ext == ".png":
                    mime_type = "image/png"
                elif ext in [".jpg", ".jpeg"]:
                    mime_type = "image/jpeg"
                else:
                    mime_type = "application/octet-stream"

                content_parts = [
                    types.Part.from_bytes(data=file_bytes, mime_type=mime_type),
                    EXTRACTION_PROMPT,
                ]

            start_time = time.time()

            response = client.models.generate_content(
                model="gemini-2.5-pro",
                contents=content_parts,
                config=types.GenerateContentConfig(temperature=0.0),
            )

            duration = time.time() - start_time
            logger.info(
                f"=== DEBUG: Gemini Extraction took {duration:.2f} seconds ==="
            )

            if hasattr(response, "usage_metadata") and response.usage_metadata:
                logger.info(
                    f"Tokens consumed: {response.usage_metadata.total_token_count}"
                )

            # Save to cache
            try:
                with open(cached_path, "w", encoding="utf-8") as f:
                    f.write(response.text)
                logger.info(f"Saved cached Markdown file: {cached_path}")
            except Exception as e:
                logger.warning(f"Failed to save cache file: {e}")

            return response.text
        except Exception as e:
            logger.error(f"Failed to extract text via Gemini: {e}")
            return ""

    def _chunk_text(
        self, text: str, chunk_size: int, chunk_overlap: int
    ) -> list[str]:
        """Chunks text by Markdown headers (# or ##)."""
        import re

        # Split by lines starting with # or ##
        # We use positive lookahead to keep the delimiter in the split result
        chunks = re.split(r"(?m)^(?=#+\s)", text)

        # Filter out empty chunks
        chunks = [c.strip() for c in chunks if c.strip()]

        # Fallback if a chunk is still too large
        final_chunks = []
        for chunk in chunks:
            if len(chunk) > chunk_size * 2:
                # Line-aware fallback to avoid breaking words/sentences
                lines = chunk.split("\n")

                # Extract header if exists to preserve context across splits
                header_line = ""
                if lines and lines[0].startswith("#"):
                    header_line = lines[0]
                    lines = lines[1:]  # Process remaining lines

                current_chunk = []
                current_length = 0

                for line in lines:
                    if (
                        current_length + len(line) > chunk_size
                        and current_chunk
                    ):
                        chunk_content = "\n".join(current_chunk)
                        if header_line:
                            chunk_content = header_line + "\n" + chunk_content
                        final_chunks.append(chunk_content)

                        # Handle overlap by keeping lines from the end that fit in chunk_overlap
                        overlap_chunk = []
                        overlap_len = 0
                        for l in reversed(current_chunk):
                            if overlap_len + len(l) < chunk_overlap:
                                overlap_chunk.insert(0, l)
                                overlap_len += len(l) + 1
                            else:
                                break
                        current_chunk = [*overlap_chunk, line]
                        current_length = sum(len(l) + 1 for l in current_chunk)
                    else:
                        current_chunk.append(line)
                        current_length += len(line) + 1

                if current_chunk:
                    chunk_content = "\n".join(current_chunk)
                    if header_line:
                        chunk_content = header_line + "\n" + chunk_content
                    final_chunks.append(chunk_content)
            else:
                final_chunks.append(chunk)

        return final_chunks

    def pre_embed_queries(self, queries: list[str]) -> None:
        """Pre-computes and caches embeddings for a list of queries in batch."""
        if not queries:
            return

        # Deduplicate to avoid redundant embedding generation
        unique_queries = list(set(queries))
        logger.info(
            f"Pre-embedding {len(unique_queries)} unique queries in batch..."
        )

        embs = self.embedder.get_embeddings(
            unique_queries, task_type="RETRIEVAL_QUERY"
        )
        for q, emb in zip(unique_queries, embs):
            self._query_embeddings_cache[q] = emb

    def retrieve(self, query: str, top_k: int = 3) -> list[dict[str, Any]]:
        """Retrieves top_k most relevant chunks for a query."""
        if not self.chunks or not self.embeddings:
            logger.warning("No document loaded or embeddings missing.")
            return []

        # Check pre-computed cache first
        query_emb = self._query_embeddings_cache.get(query)
        if not query_emb:
            query_emb = self.embedder.get_embedding(
                query, task_type="RETRIEVAL_QUERY"
            )
        if not query_emb:
            return []

        similarities = []
        for i, chunk_emb in enumerate(self.embeddings):
            sim = self.embedder.cosine_similarity(query_emb, chunk_emb)
            similarities.append((i, sim))

        # Sort by similarity
        similarities.sort(key=lambda x: x[1], reverse=True)

        results = []
        for i in range(min(top_k, len(similarities))):
            idx, sim = similarities[i]
            results.append({"text": self.chunks[idx], "score": sim})

        # Move to debug logs
        logger.debug(f"Retrieved {len(results)} chunks for query: '{query}'")
        for i, res in enumerate(results):
            logger.debug(f"Rank {i + 1} (Score: {res['score']:.4f}):")
            logger.debug(res["text"])
            logger.debug("-" * 20)

        return results

    def _convert_xlsx_to_text(self, file_path: str) -> str:
        """Reads all sheets of an Excel file and converts them locally to a CSV text representation for Gemini."""
        import pandas as pd

        try:
            logger.info(
                f"Converting Excel file locally to CSV representation: {file_path}"
            )
            xls = pd.ExcelFile(file_path)
            csv_parts = []

            for sheet_name in xls.sheet_names:
                df = pd.read_excel(xls, sheet_name=sheet_name)
                df = df.fillna("")  # Replace NaN with empty string
                csv_data = df.to_csv(index=False)
                csv_parts.append(f"--- Sheet: {sheet_name} ---\n{csv_data}")

            return "\n\n".join(csv_parts)
        except Exception as e:
            logger.error(f"Failed to convert Excel file locally to CSV: {e}")
            return ""
