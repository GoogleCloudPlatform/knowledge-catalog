from __future__ import annotations

import os
from pathlib import Path

import pytest

from aws_reference_agent.docs.reader import DocReadError, discover, read


def _write(root: Path, rel: str, text: str = "content") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_discovers_only_text_suffixes(tmp_path):
    _write(tmp_path, "a.md")
    _write(tmp_path, "b.txt")
    _write(tmp_path, "c.rst")
    _write(tmp_path, "d.pdf")
    _write(tmp_path, "e.png")

    manifest = discover(tmp_path)

    assert manifest.paths == ["a.md", "b.txt", "c.rst"]


def test_returns_sorted_relative_posix_paths(tmp_path):
    _write(tmp_path, "z.md")
    _write(tmp_path, "nested/deep/b.md")
    _write(tmp_path, "nested/a.md")

    manifest = discover(tmp_path)

    assert manifest.paths == ["nested/a.md", "nested/deep/b.md", "z.md"]


def test_include_globs_restrict_the_manifest(tmp_path):
    _write(tmp_path, "docs/schema.md")
    _write(tmp_path, "notes/scratch.md")

    manifest = discover(tmp_path, include=["docs/*"])

    assert manifest.paths == ["docs/schema.md"]


def test_exclude_globs_are_applied_after_include(tmp_path):
    _write(tmp_path, "docs/schema.md")
    _write(tmp_path, "docs/CHANGELOG.md")

    manifest = discover(tmp_path, include=["docs/*"], exclude=["*CHANGELOG*"])

    assert manifest.paths == ["docs/schema.md"]


def test_skips_dotfiles_and_dot_directories(tmp_path):
    _write(tmp_path, "visible.md")
    _write(tmp_path, ".hidden.md")
    _write(tmp_path, ".git/config.md")

    manifest = discover(tmp_path)

    assert manifest.paths == ["visible.md"]


def test_max_files_truncates_and_reports_the_drop_count(tmp_path):
    for i in range(5):
        _write(tmp_path, f"doc{i}.md")

    manifest = discover(tmp_path, max_files=2)

    assert manifest.paths == ["doc0.md", "doc1.md"]
    assert manifest.truncated_count == 3


def test_truncated_count_is_zero_when_nothing_dropped(tmp_path):
    _write(tmp_path, "only.md")

    manifest = discover(tmp_path, max_files=10)

    assert manifest.truncated_count == 0


def test_discover_rejects_a_root_that_is_not_a_directory(tmp_path):
    target = _write(tmp_path, "file.md")

    with pytest.raises(DocReadError, match="not a directory"):
        discover(target)


def test_read_returns_markdown_and_metadata(tmp_path):
    _write(tmp_path, "a.md", "# Title\n\nBody text.\n")

    doc = read(tmp_path, "a.md")

    assert doc.rel_path == "a.md"
    assert doc.markdown == "# Title\n\nBody text.\n"
    assert doc.bytes == len("# Title\n\nBody text.\n".encode("utf-8"))
    # ISO-8601 UTC, so a consumer can use it as a credibility signal.
    assert doc.modified.endswith("+00:00")


def test_title_comes_from_the_first_atx_heading(tmp_path):
    _write(tmp_path, "a.md", "\n\n#   Spaced Heading  \n\nmore\n")

    assert read(tmp_path, "a.md").title == "Spaced Heading"


def test_title_falls_back_to_first_non_blank_line(tmp_path):
    _write(tmp_path, "a.txt", "\n\nJust a line\nsecond\n")

    assert read(tmp_path, "a.txt").title == "Just a line"


def test_title_is_none_for_an_empty_document(tmp_path):
    _write(tmp_path, "a.md", "\n   \n")

    assert read(tmp_path, "a.md").title is None


def test_read_truncates_at_max_bytes_and_marks_it(tmp_path):
    _write(tmp_path, "big.md", "x" * 500)

    doc = read(tmp_path, "big.md", max_bytes=100)

    assert "[...truncated...]" in doc.markdown
    assert len(doc.markdown.encode("utf-8")) < 500
    # `bytes` reports the true on-disk size, not the truncated length.
    assert doc.bytes == 500


def test_read_rejects_parent_traversal(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    _write(tmp_path, "secret.md", "secret")

    with pytest.raises(DocReadError, match="outside"):
        read(root, "../secret.md")


def test_read_rejects_an_absolute_path(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = _write(tmp_path, "secret.md", "secret")

    with pytest.raises(DocReadError, match="outside"):
        read(root, str(outside))


def test_read_rejects_a_symlink_pointing_outside_the_root(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = _write(tmp_path, "secret.md", "secret")
    os.symlink(outside, root / "link.md")

    with pytest.raises(DocReadError, match="outside"):
        read(root, "link.md")


def test_discover_omits_a_symlink_pointing_outside_the_root(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = _write(tmp_path, "secret.md", "secret")
    os.symlink(outside, root / "link.md")
    _write(root, "real.md")

    manifest = discover(root)

    assert manifest.paths == ["real.md"]


def test_read_rejects_a_directory(tmp_path):
    (tmp_path / "sub").mkdir()

    with pytest.raises(DocReadError, match="not a regular file"):
        read(tmp_path, "sub")


def test_read_rejects_a_missing_path(tmp_path):
    with pytest.raises(DocReadError):
        read(tmp_path, "nope.md")


def test_read_decodes_invalid_utf8_without_raising(tmp_path):
    (tmp_path / "bad.md").write_bytes(b"ok \xff\xfe done")

    doc = read(tmp_path, "bad.md")

    assert "ok" in doc.markdown and "done" in doc.markdown
