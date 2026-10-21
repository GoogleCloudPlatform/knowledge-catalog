import logging
import threading
from typing import Any

import numpy as np
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)


class VertexAIEmbedder:
    """
    Utility to generate and compare embeddings using Google Gen AI SDK.
    """

    def __init__(
        self,
        project_id: str,
        location: str = "us-central1",
        model_name: str = "text-embedding-004",
        credentials: Any | None = None,
    ):
        """
        Initializes the Google Gen AI Client.
        """
        self.project_id = project_id
        self.location = location
        self.model_name = model_name
        # Use thread-local storage to avoid concurrent mutation of SSL context in multi-threaded RAG mode
        self._thread_local = threading.local()
        self._credentials = credentials

    def _get_client(self):
        # Lazily initialize client per thread to ensure thread safety
        if not hasattr(self._thread_local, "client"):
            try:
                # Use vertex_ai=True to ensure we use the Vertex AI backed API
                self._thread_local.client = genai.Client(
                    project=self.project_id,
                    location=self.location,
                    credentials=self._credentials,
                    vertexai=True,
                )
            except Exception as e:
                logger.error(f"Failed to initialize Google Gen AI Client: {e}")
                return None
        return self._thread_local.client

    def get_embeddings(
        self, texts: list[str], task_type: str = "RETRIEVAL_DOCUMENT"
    ) -> list[list[float]]:
        """
        Generates embeddings for a list of texts in batch.
        """
        client = self._get_client()
        if not client or not texts:
            return []

        all_embeddings = []
        # Batching to avoid token limit errors (e.g., 20k tokens limit)
        batch_size = 250

        try:
            for i in range(0, len(texts), batch_size):
                batch = texts[i : i + batch_size]
                logger.info(
                    f"Generating embeddings for batch {i // batch_size + 1} (size {len(batch)})..."
                )
                response = client.models.embed_content(
                    model=self.model_name,
                    contents=batch,
                    config=types.EmbedContentConfig(task_type=task_type),
                )
                all_embeddings.extend([e.values for e in response.embeddings])
            return all_embeddings
        except Exception as e:
            logger.error(
                f"Error generating embeddings with Google Gen AI SDK: {e}"
            )
            return []

    def get_embedding(
        self, text: str, task_type: str = "RETRIEVAL_DOCUMENT"
    ) -> list[float] | None:
        """
        Generates embedding for a single text.
        """
        res = self.get_embeddings([text], task_type=task_type)
        return res[0] if res else None

    @staticmethod
    def cosine_similarity(v1: list[float], v2: list[float]) -> float:
        """
        Calculates cosine similarity between two vectors.
        """
        if not v1 or not v2:
            return 0.0

        v1 = np.array(v1)
        v2 = np.array(v2)

        dot_product = np.dot(v1, v2)
        norm_v1 = np.linalg.norm(v1)
        norm_v2 = np.linalg.norm(v2)

        if norm_v1 == 0 or norm_v2 == 0:
            return 0.0

        return float(dot_product / (norm_v1 * norm_v2))
