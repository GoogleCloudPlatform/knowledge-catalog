from __future__ import annotations

import pytest

from aws_reference_agent.bundle.sql_check import (
    extract_sql_blocks,
    unknown_identifiers,
)

_KNOWN = {"user_id", "event_name", "created_at", "session_id"}

_BODY_WITH_QUERIES = """\
Prose section.

# Schema
- `user_id` BIGINT: the user identifier
- `event_name` STRING: the event name
- `created_at` TIMESTAMP: when it happened
- `session_id` STRING: the session

# Common query patterns

```sql
SELECT user_id, event_name FROM db.events WHERE created_at > '2024-01-01'
```

```sql
SELECT session_id, COUNT(*) AS cnt FROM db.events GROUP BY session_id
```

# Other section

```sql
SELECT ghost_col FROM db.events
```
"""


def test_should_return_only_sql_blocks_inside_query_patterns_section():
    blocks = extract_sql_blocks(_BODY_WITH_QUERIES)
    assert len(blocks) == 2
    assert all("ghost_col" not in b for b in blocks)
    assert any("user_id" in b for b in blocks)


def test_should_flag_column_absent_from_schema_when_identifier_not_in_known_fields():
    sql = "SELECT fake_col FROM db.events"
    result = unknown_identifiers(sql, {"user_id", "event_name"})
    assert "fake_col" in result


def test_should_not_flag_sql_keywords_or_functions_when_used_in_query():
    sql = (
        "SELECT COUNT(*), MAX(user_id), MIN(created_at), SUM(1) "
        "FROM db.events WHERE user_id IS NOT NULL "
        "GROUP BY event_name ORDER BY created_at DESC LIMIT 10"
    )
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_not_flag_table_qualified_names_when_dotted():
    # t.col is unresolvable — skip it entirely (alias-relative)
    sql = "SELECT t.user_id, t.fake_col FROM db.events AS t"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_not_flag_as_aliases_when_introduced_by_as_keyword():
    sql = "SELECT COUNT(*) AS total_rows FROM db.events"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_not_flag_from_table_aliases_when_bare_word_after_table_ref():
    # "FROM db.events e" — "e" is a table alias, must not be flagged
    sql = "SELECT e.user_id FROM db.events e"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_not_flag_unqualified_table_name_when_used_without_database():
    sql = "SELECT user_id, COUNT(*) FROM events GROUP BY user_id"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_not_flag_joined_relations_or_their_aliases_when_query_has_join():
    sql = "SELECT a.user_id FROM events a JOIN sessions b ON a.user_id = b.user_id"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_ignore_string_literals_when_present_in_query():
    sql = "SELECT user_id FROM db.events WHERE event_name = 'signup'"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_ignore_numeric_literals_when_present_in_query():
    sql = "SELECT user_id FROM db.events LIMIT 100"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []


def test_should_be_case_insensitive_when_comparing_identifiers():
    sql = "SELECT USER_ID FROM db.events"
    result = unknown_identifiers(sql, {"user_id"})
    assert result == []


def test_should_return_empty_when_all_identifiers_are_known():
    sql = "SELECT user_id, event_name FROM db.events WHERE created_at > '2024-01-01'"
    result = unknown_identifiers(sql, _KNOWN)
    assert result == []
