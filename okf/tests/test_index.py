from __future__ import annotations

from pathlib import Path

from reference_agent.bundle.document import OKFDocument
from reference_agent.bundle.index import regenerate_indexes


def _stub_synth(rel: str, children: list[tuple[str, str]], *, model: str) -> str:
    return f"stub: {len(children)} items"


def _write_doc(path: Path, type_: str, title: str, description: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = OKFDocument(
        frontmatter={
            "type": type_,
            "title": title,
            "description": description,
            "timestamp": "2026-05-27T00:00:00+00:00",
        },
        body=f"# {title}\n\n{description}\n",
    )
    path.write_text(doc.serialize(), encoding="utf-8")


def test_regenerate_groups_by_type_and_links_relative(tmp_path: Path):
    root = tmp_path / "bundle"
    _write_doc(
        root / "datasets" / "ga4.md",
        "BigQuery Dataset",
        "GA4 Dataset",
        "GA4 obfuscated ecommerce sample.",
    )
    _write_doc(
        root / "tables" / "events_.md",
        "BigQuery Table",
        "events_*",
        "Daily-sharded GA4 event tables.",
    )
    _write_doc(
        root / "tables" / "users.md",
        "BigQuery Table",
        "users",
        "Per-user dimension.",
    )

    written = regenerate_indexes(root, model="stub", synthesize=_stub_synth)
    written_names = {p.parent.name for p in written}
    assert {"bundle", "datasets", "tables"} <= written_names | {root.name}

    tables_index = (root / "tables" / "index.md").read_text(encoding="utf-8")
    assert tables_index.startswith("# BigQuery Table")
    assert "[events_*](events_.md)" in tables_index
    assert "[users](users.md)" in tables_index
    assert "Daily-sharded GA4 event tables." in tables_index

    root_index = (root / "index.md").read_text(encoding="utf-8")
    assert "# Subdirectories" in root_index
    assert "(datasets/index.md) - GA4 obfuscated ecommerce sample." in root_index
    assert "(tables/index.md) - stub: 2 items" in root_index


def test_regenerate_skips_empty_directories(tmp_path: Path):
    root = tmp_path / "bundle"
    root.mkdir()
    (root / "empty_dir").mkdir()

    written = regenerate_indexes(root, model="stub", synthesize=_stub_synth)
    assert written == []
    assert not (root / "empty_dir" / "index.md").exists()


def test_regenerate_single_child_reuses_description(tmp_path: Path):
    root = tmp_path / "bundle"
    _write_doc(
        root / "datasets" / "only.md",
        "BigQuery Dataset",
        "Only Dataset",
        "The only dataset in this bundle.",
    )

    call_count = 0

    def counting_synth(rel: str, children, *, model: str) -> str:
        nonlocal call_count
        call_count += 1
        return f"stub: {len(children)} items"

    regenerate_indexes(root, model="stub", synthesize=counting_synth)

    root_index = (root / "index.md").read_text(encoding="utf-8")
    assert "(datasets/index.md) - The only dataset in this bundle." in root_index
    assert call_count == 0
