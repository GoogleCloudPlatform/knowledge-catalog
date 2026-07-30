from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

import yaml

# OKF v0.2 §11: `type` is the only always-required frontmatter key.
REQUIRED_FRONTMATTER_KEYS = ("type",)

_FRONTMATTER_DELIM = "---"


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
            fm = yaml.safe_load(fm_text) or {}
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


def is_stale(frontmatter: dict[str, Any], today: date | None = None) -> bool:
    """Whether a concept is stale per `stale_after` (OKF v0.2 §5.5).

    A concept is stale when `today >= stale_after`. Returns False when
    `stale_after` is absent or unparseable.
    """
    raw = frontmatter.get("stale_after")
    if not raw:
        return False
    if isinstance(raw, date):
        stale_after = raw
    else:
        try:
            stale_after = date.fromisoformat(str(raw)[:10])
        except ValueError:
            return False
    return (today or date.today()) >= stale_after
