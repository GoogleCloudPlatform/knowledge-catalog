from __future__ import annotations

import re

# ---- SQL keyword / function allow-list ---------------------------------
# Conservative: when in doubt a token is allowed (false positives block writes).
_SQL_KEYWORDS: frozenset[str] = frozenset(
    """
    SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN INNER OUTER
    LEFT RIGHT FULL CROSS ON AS IN NOT AND OR IS NULL LIKE BETWEEN CASE
    WHEN THEN ELSE END DISTINCT ALL UNION INTERSECT EXCEPT WITH RECURSIVE
    INSERT INTO UPDATE SET DELETE CREATE DROP ALTER TABLE VIEW INDEX
    PARTITION OVER WINDOW ROW ROWS RANGE UNBOUNDED PRECEDING FOLLOWING
    CURRENT DESCRIBE EXPLAIN CAST EXTRACT INTERVAL TRUE FALSE
    ASC DESC USING
    """.split()
)

_SQL_FUNCTIONS: frozenset[str] = frozenset(
    """
    COUNT SUM AVG MIN MAX COALESCE NULLIF IF IFNULL NVL DECODE
    UPPER LOWER TRIM LTRIM RTRIM LENGTH SUBSTR SUBSTRING REPLACE CONCAT
    SPLIT SPLIT_PART REGEXP_REPLACE REGEXP_EXTRACT
    DATE_TRUNC DATE_DIFF DATE_ADD DATE_SUB DATE_FORMAT DATE_PARSE
    TO_DATE TO_TIMESTAMP CURRENT_DATE CURRENT_TIMESTAMP NOW
    ROUND FLOOR CEIL CEILING ABS MOD POWER SQRT LOG LOG10 EXP
    YEAR MONTH DAY HOUR MINUTE SECOND QUARTER WEEK DAYOFWEEK
    ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE
    ARBITRARY ANY_VALUE APPROX_DISTINCT APPROX_PERCENTILE PERCENTILE_APPROX
    ARRAY_AGG COLLECT_LIST COLLECT_SET STRUCT NAMED_STRUCT
    UNNEST EXPLODE LATERAL FLATTEN CARDINALITY ARRAY_SIZE
    TYPEOF TYPECAST TRY TRY_CAST SAFE_CAST
    """.split()
)

_ALLOWED_TOKENS: frozenset[str] = frozenset(
    k.lower() for k in (_SQL_KEYWORDS | _SQL_FUNCTIONS)
)

# Match fenced code blocks (```lang ... ```)
_FENCE_RE = re.compile(r"```(\w*)\n(.*?)```", re.DOTALL)

# Identifiers: word chars only, must not start with digit
_IDENTIFIER_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\b")

# String literals (single or double quoted)
_STRING_LITERAL_RE = re.compile(r"'[^']*'|\"[^\"]*\"")

# Numeric literals
_NUMERIC_LITERAL_RE = re.compile(r"\b\d+(\.\d+)?\b")

# AS alias: captures the token following AS keyword
_AS_ALIAS_RE = re.compile(r"\bAS\s+([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)

# Table reference position: the name directly after FROM/JOIN/INTO/UPDATE/TABLE
# is a relation, not a column, and an optional bare word after it is its alias.
# Both are captured so neither is mistaken for a column.
_TABLE_REF_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"
    r"([A-Za-z_][A-Za-z0-9_.]*)"
    r"(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?",
    re.IGNORECASE,
)


def section_content_lines(body: str, heading: str) -> list[str]:
    """Return non-blank lines under a top-level `# heading` section."""
    in_section = False
    out: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            in_section = stripped == heading
            continue
        if in_section and stripped:
            out.append(line)
    return out


def extract_sql_blocks(body: str) -> list[str]:
    """Return SQL fenced blocks that appear inside `# Common query patterns`.

    Parsing fences directly from the raw body scoped to that section is
    cleaner than reusing section_content_lines here because the fence
    delimiters span multiple lines and the helper strips blank lines.
    """
    # Collect start positions of section headings to find the target section's
    # character span, then extract fences within that span.
    lines = body.splitlines(keepends=True)
    section_start: int | None = None
    section_end: int | None = None
    pos = 0
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("# "):
            if stripped == "# Common query patterns":
                section_start = pos + len(line)
            elif section_start is not None and section_end is None:
                section_end = pos
        pos += len(line)

    if section_start is None:
        return []
    section_text = body[section_start:section_end] if section_end else body[section_start:]

    blocks: list[str] = []
    for m in _FENCE_RE.finditer(section_text):
        lang = m.group(1).lower()
        if lang == "sql":
            blocks.append(m.group(2).strip())
    return blocks


def unknown_identifiers(sql: str, known_fields: set[str]) -> list[str]:
    """Return bare column-like identifiers in *sql* that are absent from *known_fields*.

    Conservative: ambiguous tokens are allowed rather than flagged.

    Dotted names like ``t.col`` are skipped entirely — they are alias-relative
    and unresolvable without schema context.
    """
    known_lower = {f.lower() for f in known_fields}

    # Collect identifiers to skip (aliases, keywords, functions).
    skip: set[str] = set()

    # AS aliases
    for m in _AS_ALIAS_RE.finditer(sql):
        skip.add(m.group(1).lower())

    # Relation names and their aliases in FROM / JOIN / INTO / UPDATE position.
    # A trailing keyword (e.g. "FROM events WHERE") is not an alias, so tokens
    # already in the allow-list are left alone.
    for m in _TABLE_REF_RE.finditer(sql):
        for group in (m.group(1), m.group(2)):
            if not group:
                continue
            candidate = group.lower()
            if candidate not in _ALLOWED_TOKENS:
                skip.add(candidate)

    # Strip literals so their contents are not scanned for identifiers.
    scrubbed = _STRING_LITERAL_RE.sub("''", sql)
    scrubbed = _NUMERIC_LITERAL_RE.sub("0", scrubbed)

    unknown: list[str] = []
    seen: set[str] = set()
    for m in _IDENTIFIER_RE.finditer(scrubbed):
        token = m.group(1)
        token_lower = token.lower()

        # Skip if dotted context — find the char before the match start
        start = m.start()
        if start > 0 and scrubbed[start - 1] == ".":
            # This token appears after a dot — it is a qualified name's field part.
            continue
        # Also skip if the token itself is immediately followed by a dot (table prefix)
        end = m.end()
        if end < len(scrubbed) and scrubbed[end] == ".":
            continue

        if token_lower in _ALLOWED_TOKENS:
            continue
        if token_lower in skip:
            continue
        if token_lower in known_lower:
            continue
        if token_lower not in seen:
            seen.add(token_lower)
            unknown.append(token)

    return unknown
