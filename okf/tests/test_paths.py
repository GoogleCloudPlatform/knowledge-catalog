from __future__ import annotations

from pathlib import Path

import pytest

from reference_agent.bundle.paths import (
    concept_id_to_path,
    parse_concept_id,
    path_to_concept_id,
    resolve_reference_path,
)


def test_concept_id_to_path():
    root = Path("/bundle")
    assert concept_id_to_path(root, ("tables", "orders")) == Path(
        "/bundle/tables/orders.md"
    )


def test_path_to_concept_id():
    root = Path("/bundle")
    path = Path("/bundle/tables/orders.md")
    assert path_to_concept_id(root, path) == ("tables", "orders")


def test_parse_concept_id():
    assert parse_concept_id("tables/orders") == ("tables", "orders")
    assert parse_concept_id("/tables/orders/") == ("tables", "orders")


def test_resolve_absolute_url_unchanged():
    root = Path("/bundle")
    concept = Path("/bundle/computations/revenue-ytd.md")

    assert resolve_reference_path(
        root, concept, "https://example.com/revenue"
    ) == "https://example.com/revenue"


def test_resolve_bundle_relative_path():
    root = Path("/bundle")
    concept = Path("/bundle/computations/revenue-ytd.md")

    assert resolve_reference_path(
        root, concept, "/tables/orders.md"
    ) == "/tables/orders.md"


def test_resolve_relative_path_from_concept_directory():
    root = Path("/bundle")
    concept = Path("/bundle/computations/revenue-ytd.md")

    assert resolve_reference_path(
        root, concept, "../tables/orders.md"
    ) == "/tables/orders.md"


def test_resolve_nested_relative_path():
    root = Path("/bundle")
    concept = Path("/bundle/computations/revenue-ytd.md")

    assert resolve_reference_path(
        root, concept, "skills/run-on-bq.md"
    ) == "/computations/skills/run-on-bq.md"


def test_resolve_relative_path_cannot_escape_bundle():
    root = Path("/bundle")
    concept = Path("/bundle/computations/revenue-ytd.md")

    with pytest.raises(ValueError):
        resolve_reference_path(root, concept, "../../outside.md")
