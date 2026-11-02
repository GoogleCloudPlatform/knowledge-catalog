import logging
import re
from typing import Any

from .vertex_embedder import VertexAIEmbedder

logger = logging.getLogger(__name__)


class SimilarityEngine:
    """Calculates similarity between columns and business glossary terms."""

    def __init__(
        self,
        project_id: str | None = None,
        location: str = "us-central1",
        credentials: Any | None = None,
    ):
        # weights for different signals
        self.weights = {
            "lexical": 0.3,  # Matches on string tokens (names, IDs)
            "semantic": 0.5,  # Matches on vector embeddings (meanings)
            "lineage": 0.2,  # Boost based on upstream associations
        }
        self.project_id = project_id
        self.embedder = (
            VertexAIEmbedder(project_id, location, credentials=credentials)
            if project_id
            else None
        )
        # Cache for term embeddings: TermID -> Embedding
        self.term_embeddings = {}

    def set_term_embeddings(self, embeddings: dict[str, list[float]]):
        """Sets pre-calculated embeddings for glossary terms."""
        self.term_embeddings = embeddings

    def _normalize(self, text: str) -> str:
        if not text:
            return ""
        # Lowercase, remove special chars, split by underscore/camelCase
        text = text.lower()
        text = re.sub(r"[^a-z0-9]", " ", text)
        return text.strip()

    def _get_primary_entity(self, text: str) -> str | None:
        """Extracts the primary business entity from text."""
        # Main entities (conflict-prone)
        entities = [
            "customer",
            "order",
            "item",
            "product",
            "transaction",
            "user",
            "account",
            "membership",
            "loyalty",
        ]
        # Abbreviations/Aliases
        aliases = {
            "cust": "customer",
            "prod": "product",
            "txn": "transaction",
            "trans": "transaction",
            "acc": "account",
        }

        text_norm = self._normalize(text)
        tokens = text_norm.split()

        # Check aliases first
        for alias, entity in aliases.items():
            if alias in tokens:
                return entity

        # Check entities
        for entity in entities:
            if entity in tokens:
                return entity

        return None

    def _get_concept(self, text: str) -> str | None:
        """Identifies the technical or business concept (ID, Amount, Timestamp, etc.)."""
        # Concept maps
        concept_map = {
            "id": ["id", "identifier", "pk", "fk", "key", "code", "sku"],
            "amount": [
                "amount",
                "price",
                "total",
                "sum",
                "cost",
                "value",
                "subtotal",
                "tax",
                "discount",
            ],
            "timestamp": [
                "timestamp",
                "date",
                "time",
                "ts",
                "added",
                "at",
                "created",
                "updated",
            ],
            "category": [
                "category",
                "group",
                "type",
                "class",
                "genre",
                "level",
            ],
        }

        text_norm = self._normalize(text)
        tokens = text_norm.split()

        for concept, keywords in concept_map.items():
            for kw in keywords:
                if kw in tokens:
                    return concept

        return None

    def _detect_entity_conflict(
        self, col_name: str, term_display: str, term_id: str
    ) -> bool:
        """Detects if a column and term belong to fundamentally different entities."""
        col_entity = self._get_primary_entity(col_name)
        term_entity = self._get_primary_entity(
            term_display
        ) or self._get_primary_entity(term_id)

        if not col_entity or not term_entity:
            return False

        if col_entity == term_entity:
            return False

        # Specific allowed overlaps (aliases)
        compatibles = [
            {"order", "transaction"},
            {"item", "product"},
            {"amount", "price"},
            {"date", "timestamp"},
        ]
        for pair in compatibles:
            if {col_entity, term_entity} == pair:
                return False

        # If both are entities (not concepts), it's a conflict
        entities = {
            "customer",
            "user",
            "account",
            "product",
            "item",
            "order",
            "transaction",
        }
        if col_entity in entities and term_entity in entities:
            return True

        return False

    def calculate_lexical_similarity(
        self, col_name: str, term_display: str, term_id: str = ""
    ) -> float:
        """Jaccard similarity on normalized tokens, including term ID."""
        s1 = set(self._normalize(col_name).split())
        s2 = set(self._normalize(term_display).split())
        if term_id:
            s2 = s2.union(set(self._normalize(term_id).split()))

        if not s1 or not s2:
            return 0.0

        intersection = len(s1.intersection(s2))
        union = len(s1.union(s2))

        return intersection / union

    def calculate_semantic_similarity(
        self,
        col_metadata: dict[str, Any],
        term: dict[str, Any],
        col_embedding: list[float] | None = None,
    ) -> float:
        """
        Calculates similarity using Vertex AI embeddings.
        Fallback to description keyword matching if embeddings are unavailable.
        """
        term_id = term["name"]
        term_emb = self.term_embeddings.get(term_id)

        # Priority 1: Vector Similarity
        if col_embedding and term_emb:
            return self.embedder.cosine_similarity(col_embedding, term_emb)

        # Priority 2: Fallback to keyword overlap
        col_desc = col_metadata.get("description", "").lower()
        term_desc = term.get("description", "").lower()

        if not col_desc or not term_desc:
            return 0.0

        # Placeholder: keyword overlap in descriptions + term name
        s1 = set(self._normalize(col_desc).split())
        s2 = set(self._normalize(term_desc).split())
        s2_name = set(self._normalize(term.get("display_name", "")).split())
        s2 = s2.union(s2_name)

        if not s1 or not s2:
            return 0.0

        intersection = len(s1.intersection(s2))
        # Use min length for overlap to be more forgiving on descriptions
        score = intersection / min(len(s1), len(s2))

        return min(score, 1.0)

    def calculate_total_score(
        self,
        column: dict[str, Any],
        term: dict[str, Any],
        col_embedding: list[float] | None = None,
    ) -> dict[str, Any]:
        """Calculates combined score and returns detailed signals."""
        col_name = column["name"]
        col_entity = self._get_primary_entity(col_name)

        term_id_full = term["name"]
        term_id_base = term_id_full.split("/")[-1]
        term_display = term["display_name"]

        lexical = self.calculate_lexical_similarity(
            col_name, term_display, term_id=term_id_base
        )
        semantic = self.calculate_semantic_similarity(
            column, term, col_embedding=col_embedding
        )

        # Combine scores
        score = (lexical * self.weights["lexical"]) + (
            semantic * self.weights["semantic"]
        )

        # 1. Entity Conflict Penalty
        conflict = self._detect_entity_conflict(
            col_name, term_display, term_id_base
        )
        if conflict:
            score -= 0.30

        # 2. Entity Match Boost
        term_entity = self._get_primary_entity(
            term_display
        ) or self._get_primary_entity(term_id_base)
        if col_entity and term_entity and col_entity == term_entity:
            score += 0.15

        # 3. Concept Alignment
        col_concept = self._get_concept(col_name)
        term_concept = self._get_concept(term_display) or self._get_concept(
            term_id_base
        )

        if col_concept and term_concept:
            if col_concept == term_concept:
                score += 0.1
            else:
                score -= 0.35

        # 4. Exact Word Match Boost
        col_words = set(self._normalize(col_name).split())
        term_words = set(self._normalize(term_display).split())
        if col_words.intersection(term_words):
            score += 0.05

        return {
            "total": round(max(0, score), 2),
            "lexical": round(lexical, 2),
            "semantic": round(semantic, 2),
        }

    def get_ranked_suggestions(
        self,
        column: dict[str, Any],
        all_terms: list[dict[str, Any]],
        col_embedding: list[float] | None = None,
    ) -> list[dict[str, Any]]:
        """Produces ranked suggestions for a single column with adaptive filtering and entity awareness."""
        suggestions = []
        for term in all_terms:
            signals = self.calculate_total_score(
                column, term, col_embedding=col_embedding
            )
            score = signals["total"]

            # Base Thresholding
            if score >= 0.30:
                suggestions.append(
                    {
                        "term_name": term["name"],
                        "display_name": term["display_name"],
                        "confidence": score,
                        "signals": signals,
                    }
                )

        # Sort by confidence
        suggestions.sort(key=lambda x: x["confidence"], reverse=True)

        # 5. Competitive Filtering:
        if suggestions:
            top_score = suggestions[0]["confidence"]
            if top_score > 0.45:
                suggestions = [
                    s
                    for s in suggestions
                    if s["confidence"] >= (top_score * 0.7)
                ]

        return suggestions[:5]  # Top 5 relevant matches
