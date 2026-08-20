from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import yaml

# OKF v0.2 §11: `type` is the only always-required frontmatter key.
REQUIRED_FRONTMATTER_KEYS = ("type",)

_FRONTMATTER_DELIM = "---"


class _Loader(yaml.SafeLoader):
    """SafeLoader that leaves timestamps as the text the author wrote.

    PyYAML implements YAML 1.1, whose implicit resolvers turn a value like
    `2026-06-30T14:00:00Z` into a `datetime`. Dumping it back yields
    `2026-06-30 14:00:00+00:00`, so a parse/serialize round-trip silently
    rewrites the author's frontmatter. Dropping the resolver keeps every
    value a string, matching the YAML 1.2 core schema.
    """


_Loader.yaml_implicit_resolvers = {
    ch: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for ch, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


class OKFDocumentError(ValueError):
    pass


@dataclass
class OKFDocument:
    frontmatter: dict[str, Any] = field(default_factory=dict)
    body: str = ""

    @classmethod
    def parse(cls, text: str) -> "OKFDocument":
        lines = text.splitlines()
        if not lines or lines[0].strip() != _FRONTMATTER_DELIM:
            return cls(frontmatter={}, body=text)

        end_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == _FRONTMATTER_DELIM:
                end_idx = i
                break
        if end_idx is None:
            raise OKFDocumentError("Unterminated YAML frontmatter block")

        fm_text = "\n".join(lines[1:end_idx])
        try:
            fm = yaml.load(fm_text, Loader=_Loader) or {}
        except yaml.YAMLError as e:
            raise OKFDocumentError(f"Invalid YAML in frontmatter: {e}") from e
        if not isinstance(fm, dict):
            raise OKFDocumentError("Frontmatter must be a YAML mapping")

        body = "\n".join(lines[end_idx + 1:])
        if body.startswith("\n"):
            body = body[1:]
        return cls(frontmatter=fm, body=body)

    def serialize(self) -> str:
        fm_text = yaml.safe_dump(
            self.frontmatter, sort_keys=False, allow_unicode=True
        ).rstrip()
        body = self.body if self.body.endswith("\n") else self.body + "\n"
        return f"{_FRONTMATTER_DELIM}\n{fm_text}\n{_FRONTMATTER_DELIM}\n\n{body}"

    def validate(self) -> None:
        missing = [k for k in REQUIRED_FRONTMATTER_KEYS if not self.frontmatter.get(k)]
        if missing:
            raise OKFDocumentError(
                f"Missing required frontmatter keys: {', '.join(missing)}"
            )


def normalize_verified(frontmatter: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the `verified` events as a list (OKF v0.2 §5.2).

    A single verifier MAY be written as one `{ by, at }` mapping without the
    list dash; consumers MUST treat a bare mapping as a one-element list.
    """
    verified = frontmatter.get("verified")
    if verified is None:
        return []
    if isinstance(verified, dict):
        return [verified]
    if isinstance(verified, list):
        return [v for v in verified if isinstance(v, dict)]
    return []


def trust_tier(frontmatter: dict[str, Any]) -> str:
    """Derive a concept's trust tier from `verified` (OKF v0.2 §5.3).

    - No `verified` key ⇒ "unverified".
    - `verified` by non-`human:` actors only ⇒ "machine-confirmed".
    - `verified` by a `human:<id>` actor ⇒ "human-reviewed".
    """
    events = normalize_verified(frontmatter)
    if not events:
        return "unverified"
    for event in events:
        by = str(event.get("by") or "")
        if by.startswith("human:"):
            return "human-reviewed"
    return "machine-confirmed"


def is_stale(frontmatter: dict[str, Any], now: datetime | None = None) -> bool:
    """Whether a concept is stale per `stale_after` (OKF v0.2 §5.5).

    A concept is stale when `now >= stale_after`. Returns False when
    `stale_after` is absent, or is not an ISO 8601 datetime with an explicit
    UTC offset: §11 requires a consumer to ignore such a value, and a
    date-only `2026-12-31` names a different instant in every timezone.
    """
    raw = str(frontmatter.get("stale_after") or "")
    if "T" not in raw:
        return False
    try:
        stale_after = datetime.fromisoformat(raw)
    except ValueError:
        return False
    if stale_after.tzinfo is None:
        return False
    return (now or datetime.now(timezone.utc)) >= stale_after
