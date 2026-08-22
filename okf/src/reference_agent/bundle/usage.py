from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

USAGE_FILENAME = "usage.yaml"
USAGE_VERSION = 1



class UsageError(ValueError):
    """Raised when usage metadata is malformed or unsafe."""


@dataclass
class UsageHint:
    concept: str
    intent: str
    conditions: dict[str, Any] = field(default_factory=dict)
    access_count: int = 0
    successful_count: int | None = None
    last_accessed: str | None = None
    extensions: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, value: Any) -> "UsageHint":
        if not isinstance(value, dict):
            raise UsageError("Each usage_hints entry must be a mapping")
        concept = value.get("concept")
        intent = value.get("intent")
        conditions = value.get("conditions", {})
        if not isinstance(concept, str) or not concept:
            raise UsageError("Usage hint concept must be a non-empty string")
        if not isinstance(intent, str) or not intent:
            raise UsageError("Usage hint intent must be a non-empty string")
        if not isinstance(conditions, dict):
            raise UsageError("Usage hint conditions must be a mapping")
        access_count = _non_negative_int(value.get("access_count", 0), "access_count")
        successful_raw = value.get("successful_count")
        successful_count = (
            None
            if successful_raw is None
            else _non_negative_int(successful_raw, "successful_count")
        )
        if successful_count is not None and successful_count > access_count:
            raise UsageError("successful_count cannot exceed access_count")
        last_accessed = value.get("last_accessed")
        if last_accessed is not None and not isinstance(last_accessed, str):
            raise UsageError("last_accessed must be an ISO-8601 string")
        extensions = {
            key: item
            for key, item in value.items()
            if key not in {
                "concept", "intent", "conditions", "access_count",
                "successful_count", "last_accessed",
            }
        }
        return cls(
            concept=concept,
            intent=intent,
            conditions=dict(conditions),
            access_count=access_count,
            successful_count=successful_count,
            last_accessed=last_accessed,
            extensions=extensions,
        )

    def to_mapping(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "concept": self.concept,
            "intent": self.intent,
        }
        if self.conditions:
            value["conditions"] = self.conditions
        value["access_count"] = self.access_count
        if self.successful_count is not None:
            value["successful_count"] = self.successful_count
        if self.last_accessed is not None:
            value["last_accessed"] = self.last_accessed
        value.update(self.extensions)
        return value


@dataclass
class UsageFile:
    hints: list[UsageHint] = field(default_factory=list)
    version: int = USAGE_VERSION
    extensions: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, value: Any) -> "UsageFile":
        if not isinstance(value, dict):
            raise UsageError("usage.yaml must contain a mapping")
        version = value.get("version", USAGE_VERSION)
        if version != USAGE_VERSION:
            raise UsageError(f"Unsupported usage.yaml version: {version!r}")
        raw_hints = value.get("usage_hints", [])
        if not isinstance(raw_hints, list):
            raise UsageError("usage_hints must be a list")
        hints = [UsageHint.from_mapping(item) for item in raw_hints]
        extensions = {
            key: item for key, item in value.items() if key not in {"version", "usage_hints"}
        }
        return cls(hints=hints, version=version, extensions=extensions)

    def to_mapping(self) -> dict[str, Any]:
        value = {
            "version": self.version,
            "usage_hints": [hint.to_mapping() for hint in self.hints],
        }
        value.update(self.extensions)
        return value


def _non_negative_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise UsageError(f"{name} must be a non-negative integer")
    return value


def _validate_concept_path(concept: str) -> None:
    path = PurePosixPath(concept)
    if path.is_absolute() or ".." in path.parts or path.suffix != ".md":
        raise UsageError(f"Invalid usage hint concept path: {concept!r}")
    if path.name in {"index.md", "log.md", "usage.yaml"}:
        raise UsageError(f"Usage hint cannot target reserved file: {concept!r}")


def load_usage(bundle_root: Path) -> UsageFile:
    path = bundle_root / USAGE_FILENAME
    if not path.exists():
        return UsageFile()
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as error:
        raise UsageError(f"Invalid YAML in {USAGE_FILENAME}: {error}") from error
    usage = UsageFile.from_mapping(raw)
    for hint in usage.hints:
        _validate_concept_path(hint.concept)
    return usage


def save_usage(bundle_root: Path, usage: UsageFile) -> Path:
    bundle_root.mkdir(parents=True, exist_ok=True)
    path = bundle_root / USAGE_FILENAME
    payload = yaml.safe_dump(usage.to_mapping(), sort_keys=False)
    fd, temporary = tempfile.mkstemp(prefix=".usage-", dir=bundle_root, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(payload)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def record_usage(
    bundle_root: Path,
    concept: str,
    intent: str,
    conditions: dict[str, Any] | None = None,
    *,
    successful: bool = False,
    accessed_at: datetime | None = None,
) -> UsageHint:
    _validate_concept_path(concept)
    if not intent:
        raise UsageError("intent must be a non-empty string")
    normalized_conditions = dict(conditions or {})
    usage = load_usage(bundle_root)
    for hint in usage.hints:
        if (hint.concept, hint.intent, hint.conditions) == (
            concept,
            intent,
            normalized_conditions,
        ):
            break
    else:
        hint = UsageHint(concept=concept, intent=intent, conditions=normalized_conditions)
        usage.hints.append(hint)
    hint.access_count += 1
    if successful:
        hint.successful_count = (hint.successful_count or 0) + 1
    hint.last_accessed = (accessed_at or datetime.now(timezone.utc)).isoformat()
    save_usage(bundle_root, usage)
    return hint


def rank_usage(
    bundle_root: Path,
    intent: str,
    conditions: dict[str, Any] | None = None,
) -> list[UsageHint]:
    requested = dict(conditions or {})
    candidates = [
        hint
        for hint in load_usage(bundle_root).hints
        if not intent or hint.intent == intent
    ]
    def score(hint: UsageHint) -> tuple[int, int, str]:
        matches = sum(
            hint.conditions.get(key) == value
            for key, value in requested.items()
        )
        return matches, hint.access_count, hint.concept

    return sorted(candidates, key=score, reverse=True)