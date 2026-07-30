"""Parse Hive/Glue column type strings into nested field dicts.

Glue (and Athena/Hive) describe column types as strings like
``array<struct<a:int,b:string>>``. This module turns those strings into the
nested ``{"name", "type", "mode", "description", "fields"}`` shape the prompts
and the viewer expect.
"""

from __future__ import annotations

from typing import Any


def parse_hive_type(type_str: str) -> dict[str, Any]:
    """Parse a Hive/Glue type string into a nested field-dict shape.

    Never raises: unparseable input falls back to ``{"type": type_str}``.
    """
    try:
        return _parse(type_str.strip())
    except Exception:
        return {"type": type_str}


def column_to_field(col: dict[str, Any]) -> dict[str, Any]:
    """Convert a Glue ``{"Name", "Type", "Comment"}`` column dict to a field dict."""
    field = {"name": col["Name"], **parse_hive_type(col["Type"])}
    comment = col.get("Comment")
    if comment:
        field["description"] = comment
    return field


def _parse(s: str) -> dict[str, Any]:
    if not s:
        return {"type": s}

    low = s.lower()

    if low.startswith("array<") and s.endswith(">"):
        inner = s[len("array<") : -1]
        parsed = _parse(inner.strip())
        parsed["mode"] = "REPEATED"
        return parsed

    if low.startswith("struct<") and s.endswith(">"):
        inner = s[len("struct<") : -1]
        return {
            "type": "struct",
            "mode": "NULLABLE",
            "fields": _parse_struct_fields(inner),
        }

    if low.startswith("map<") and s.endswith(">"):
        inner = s[len("map<") : -1]
        parts = _split_top_level(inner)
        if len(parts) != 2:
            return {"type": s}
        key_type = parts[0].strip()
        value_type = _parse(parts[1].strip())
        return {"type": "map", "key_type": key_type, "value_type": value_type}

    return {"type": s}


def _parse_struct_fields(inner: str) -> list[dict[str, Any]]:
    fields = []
    for part in _split_top_level(inner):
        part = part.strip()
        if not part:
            continue
        name, _, type_str = part.partition(":")
        parsed = _parse(type_str.strip())
        field = {"name": name.strip(), **parsed}
        if "mode" not in field and field.get("type") != "map":
            field["mode"] = "NULLABLE"
        fields.append(field)
    return fields


def _split_top_level(s: str) -> list[str]:
    """Split on commas at depth 0, ignoring commas inside <...> or (...)."""
    parts = []
    depth = 0
    current = ""
    for ch in s:
        if ch in "<(":
            depth += 1
            current += ch
        elif ch in ">)":
            depth -= 1
            current += ch
        elif ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    parts.append(current)
    return parts
