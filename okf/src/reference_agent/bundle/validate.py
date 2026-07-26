"""Deterministic conformance validation for OKF bundles (SPEC v0.2 §11)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from reference_agent.bundle.document import (
    OKFDocument,
    OKFDocumentError,
    normalize_verified,
)

_STATUS_VALUES = {"draft", "stable", "deprecated"}
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_LINK_RE = re.compile(r"\]\(([^)\s]+\.md)(?:#[A-Za-z0-9_\-]*)?\)")
_FOOTNOTE_RE = re.compile(r"\[\^([A-Za-z0-9_\-]+)\]")
_INDEX_BULLET_RE = re.compile(r"^\*\s")
_INDEX_ENTRY_RE = re.compile(r"^\*\s+\[[^\]]+\]\([^)\s]+\)")

ATTESTED_COMPUTATION_TYPE = "Attested Computation"


@dataclass(frozen=True)
class Finding:
    severity: str  # "error" | "warning"
    rule: str
    path: str  # posix-style path relative to the bundle root
    message: str


@dataclass
class ValidationReport:
    findings: list[Finding] = field(default_factory=list)

    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors()


def validate_bundle(bundle_root: Path) -> ValidationReport:
    """Validate every markdown file under ``bundle_root``.

    Errors are SPEC v0.2 §11 base-conformance violations; warnings cover
    SHOULD-level rules and shape checks for optional frontmatter families
    that are present. Broken links are warnings because consumers MUST
    tolerate them (§6).
    """
    if not bundle_root.is_dir():
        raise FileNotFoundError(f"Bundle directory not found: {bundle_root}")

    report = ValidationReport()
    md_files = sorted(bundle_root.rglob("*.md"))
    existing = {p.relative_to(bundle_root).as_posix() for p in md_files}

    for md_path in md_files:
        rel = md_path.relative_to(bundle_root).as_posix()
        try:
            raw = md_path.read_text(encoding="utf-8").lstrip("\ufeff")
        except UnicodeDecodeError as exc:
            if md_path.name == "index.md":
                rule = "index-malformed"
            elif md_path.name == "log.md":
                rule = "log-malformed"
            else:
                rule = "frontmatter-unparseable"
            report.findings.append(
                Finding(
                    "error",
                    rule,
                    rel,
                    "Not valid UTF-8 (SPEC v0.2 \u00a74: concept documents are "
                    f"UTF-8): {exc}",
                )
            )
            continue
        if md_path.name == "index.md":
            _check_index(raw, rel, md_path.parent == bundle_root, report)
        elif md_path.name == "log.md":
            _check_log(raw, rel, report)
        else:
            _check_concept(raw, rel, report, existing=existing)
    return report


def _has_frontmatter(raw: str) -> bool:
    first = raw.splitlines()[0].strip() if raw else ""
    return first == "---"


def _strip_fences(body: str) -> str:
    kept: list[str] = []
    in_fence = False
    for line in body.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            in_fence = not in_fence
            continue
        if not in_fence:
            kept.append(line)
    return "\n".join(kept)


def _parses_as_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _check_concept(
    raw: str, rel: str, report: ValidationReport, *, existing: set[str]
) -> None:
    if not _has_frontmatter(raw):
        report.findings.append(
            Finding(
                "error",
                "frontmatter-missing",
                rel,
                "Concept document has no YAML frontmatter block (SPEC v0.2 §11).",
            )
        )
        return
    try:
        doc = OKFDocument.parse(raw)
    except OKFDocumentError as exc:
        report.findings.append(
            Finding("error", "frontmatter-unparseable", rel, str(exc))
        )
        return

    fm = doc.frontmatter
    type_value = fm.get("type")
    if not isinstance(type_value, str) or not type_value.strip():
        report.findings.append(
            Finding(
                "error",
                "type-missing",
                rel,
                "Frontmatter must carry a non-empty `type` (SPEC v0.2 §11).",
            )
        )

    _check_families(fm, rel, report)

    body = _strip_fences(doc.body)
    _check_links(body, rel, report, existing)
    _check_footnotes(body, fm, rel, report)
    if any(line.strip() == "# Citations" for line in body.splitlines()):
        report.findings.append(
            Finding(
                "warning",
                "citations-legacy",
                rel,
                "Body `# Citations` is an OKF v0.1 construct; use `sources` "
                "frontmatter with footnotes (SPEC v0.2 §13).",
            )
        )
    if isinstance(type_value, str) and type_value.strip() == ATTESTED_COMPUTATION_TYPE:
        _check_attested(fm, body, rel, report)


def _check_families(fm: dict[str, Any], rel: str, report: ValidationReport) -> None:
    if "sources" in fm:
        sources = fm["sources"]
        if not isinstance(sources, list):
            report.findings.append(
                Finding(
                    "warning",
                    "sources-entry-missing-resource",
                    rel,
                    "`sources` must be a list of entries (SPEC v0.2 §5.1).",
                )
            )
        else:
            bad = [
                i
                for i, entry in enumerate(sources)
                if not isinstance(entry, dict)
                or not str(entry.get("resource") or "").strip()
            ]
            if bad:
                report.findings.append(
                    Finding(
                        "warning",
                        "sources-entry-missing-resource",
                        rel,
                        "`sources` entries missing a `resource` "
                        f"(SPEC v0.2 §5.1): indices {bad}.",
                    )
                )
    if "generated" in fm:
        generated = fm["generated"]
        if not isinstance(generated, dict) or not str(
            generated.get("by") or ""
        ).strip():
            report.findings.append(
                Finding(
                    "warning",
                    "generated-missing-by",
                    rel,
                    "`generated` must be a mapping with a non-empty `by` "
                    "(SPEC v0.2 §5.2).",
                )
            )
    if "verified" in fm:
        verified = fm["verified"]
        events = normalize_verified(fm)
        malformed = not isinstance(verified, (dict, list))
        if isinstance(verified, list) and len(events) != len(verified):
            malformed = True
        if any(
            not str(event.get("by") or "").strip() or not event.get("at")
            for event in events
        ):
            malformed = True
        if malformed:
            report.findings.append(
                Finding(
                    "warning",
                    "verified-shape",
                    rel,
                    "`verified` must be a `{by, at}` mapping or a list of "
                    "them (SPEC v0.2 §5.2).",
                )
            )
    if "status" in fm and fm["status"] not in _STATUS_VALUES:
        report.findings.append(
            Finding(
                "warning",
                "status-invalid",
                rel,
                "`status` must be draft|stable|deprecated (SPEC v0.2 §5.4); "
                f"got {fm['status']!r}.",
            )
        )
    if "stale_after" in fm:
        value = fm["stale_after"]
        valid = (isinstance(value, date) and not isinstance(value, datetime)) or (
            isinstance(value, str)
            and bool(_ISO_DATE_RE.match(value))
            and _parses_as_date(value)
        )
        if not valid:
            report.findings.append(
                Finding(
                    "warning",
                    "stale-after-invalid",
                    rel,
                    "`stale_after` must be a `YYYY-MM-DD` date (SPEC v0.2 §5.5).",
                )
            )
    if "timestamp" in fm:
        report.findings.append(
            Finding(
                "warning",
                "timestamp-legacy",
                rel,
                "`timestamp` is an OKF v0.1 legacy key; migrate to "
                "`generated.at` (SPEC v0.2 §13).",
            )
        )


def _resolve_link(target: str, rel_dir: PurePosixPath) -> str | None:
    if target.startswith("/"):
        parts = PurePosixPath(target[1:]).parts
    else:
        parts = (rel_dir / target).parts
    resolved: list[str] = []
    for part in parts:
        if part == ".":
            continue
        if part == "..":
            if not resolved:
                return None
            resolved.pop()
        else:
            resolved.append(part)
    return "/".join(resolved)


def _check_links(
    body: str, rel: str, report: ValidationReport, existing: set[str]
) -> None:
    rel_dir = PurePosixPath(rel).parent
    seen: set[str] = set()
    for target in _LINK_RE.findall(body):
        if "://" in target or target in seen:
            continue
        seen.add(target)
        resolved = _resolve_link(target, rel_dir)
        if resolved is None:
            report.findings.append(
                Finding(
                    "warning",
                    "link-broken",
                    rel,
                    f"Link `{target}` escapes the bundle root.",
                )
            )
        elif resolved not in existing:
            report.findings.append(
                Finding(
                    "warning",
                    "link-broken",
                    rel,
                    f"Link target `{target}` not found in bundle "
                    "(tolerated by consumers per SPEC v0.2 §6).",
                )
            )


def _check_footnotes(
    body: str, fm: dict[str, Any], rel: str, report: ValidationReport
) -> None:
    labels = set(_FOOTNOTE_RE.findall(body))
    if not labels:
        return
    sources = fm.get("sources")
    ids: set[str] = set()
    if isinstance(sources, list):
        ids = {
            str(entry.get("id"))
            for entry in sources
            if isinstance(entry, dict) and entry.get("id")
        }
    unmatched = sorted(labels - ids)
    if unmatched:
        report.findings.append(
            Finding(
                "warning",
                "footnote-unmatched",
                rel,
                "Footnote labels with no matching `sources[].id` "
                f"(SPEC v0.2 §5.1): {', '.join(unmatched)}.",
            )
        )


def _check_attested(
    fm: dict[str, Any], body: str, rel: str, report: ValidationReport
) -> None:
    problems: list[str] = []
    if not str(fm.get("runtime") or "").strip():
        problems.append("missing `runtime` (§10.2)")
    parameters = fm.get("parameters")
    if parameters is not None and (
        not isinstance(parameters, list)
        or any(
            not isinstance(p, dict) or not str(p.get("name") or "").strip()
            for p in parameters
        )
    ):
        problems.append("`parameters` must be a list of mappings with `name` (§10.2)")
    has_inline = any(line.strip() == "# Computation" for line in body.splitlines())
    if not str(fm.get("computation") or "").strip() and not has_inline:
        problems.append("no `computation` path and no `# Computation` section (§10.2)")
    if problems:
        report.findings.append(
            Finding(
                "warning",
                "attested-computation-incomplete",
                rel,
                "Attested Computation: " + "; ".join(problems) + ".",
            )
        )


def _check_index(
    raw: str, rel: str, is_root: bool, report: ValidationReport
) -> None:
    body = raw
    if _has_frontmatter(raw):
        if not is_root:
            report.findings.append(
                Finding(
                    "error",
                    "index-malformed",
                    rel,
                    "Only the bundle-root index.md may carry frontmatter "
                    "(SPEC v0.2 §8, §12).",
                )
            )
            return
        try:
            body = OKFDocument.parse(raw).body
        except OKFDocumentError as exc:
            report.findings.append(Finding("error", "index-malformed", rel, str(exc)))
            return
    for line in _strip_fences(body).splitlines():
        if _INDEX_BULLET_RE.match(line) and not _INDEX_ENTRY_RE.match(line):
            report.findings.append(
                Finding(
                    "error",
                    "index-malformed",
                    rel,
                    "Index entry must be link-first `* [Title](url) - "
                    f"description` (SPEC v0.2 §8): {line.strip()!r}.",
                )
            )


def _check_log(raw: str, rel: str, report: ValidationReport) -> None:
    body = raw
    if _has_frontmatter(raw):
        try:
            body = OKFDocument.parse(raw).body
        except OKFDocumentError as exc:
            report.findings.append(Finding("error", "log-malformed", rel, str(exc)))
            return
    for line in _strip_fences(body).splitlines():
        if line.startswith("## "):
            heading = line[3:].strip()
            if not (_ISO_DATE_RE.match(heading) and _parses_as_date(heading)):
                report.findings.append(
                    Finding(
                        "error",
                        "log-malformed",
                        rel,
                        "log.md date headings must be `## YYYY-MM-DD` "
                        f"(SPEC v0.2 §9); got {heading!r}.",
                    )
                )
