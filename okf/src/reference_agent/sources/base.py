from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ConceptRef:
    id: tuple[str, ...]
    type: str
    resource: str | None = None
    hint: dict[str, Any] = field(default_factory=dict)

    @property
    def id_str(self) -> str:
        return "/".join(self.id)


class Source(ABC):
    name: str = ""

    @abstractmethod
    def list_concepts(self) -> list[ConceptRef]:
        ...

    @abstractmethod
    def read_concept(self, ref: ConceptRef) -> dict[str, Any]:
        ...

    def sample_rows(self, ref: ConceptRef, n: int = 5) -> list[dict[str, Any]] | None:
        return None

    def find(self, concept_id: tuple[str, ...]) -> ConceptRef | None:
        for ref in self.list_concepts():
            if ref.id == concept_id:
                return ref
        return None
