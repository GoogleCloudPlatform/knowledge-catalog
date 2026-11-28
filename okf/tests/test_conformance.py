from __future__ import annotations

from pathlib import Path

import pytest

from reference_agent.bundle.conformance import Violation, check_bundle

_BUNDLES_DIR = Path(__file__).resolve().parents[1] / "bundles"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# --- the committed sample bundles must be conformant ----------------------


@pytest.mark.parametrize("name", ["crypto_bitcoin", "ga4", "stackoverflow"])
def test_committed_bundles_are_conformant(name: str):
    bundle = _BUNDLES_DIR / name
    if not bundle.is_dir():
        pytest.skip(f"bundle '{name}' not present")
    violations = check_bundle(bundle)
    assert violations == [], "\n".join(str(v) for v in violations)


# --- §9.1: frontmatter block present and parseable ------------------------


def test_missing_frontmatter_block_is_9_1(tmp_path: Path):
    _write(tmp_path / "tables" / "x.md", "No frontmatter here.\n")
    violations = check_bundle(tmp_path)
    assert [(v.path, v.rule) for v in violations] == [("tables/x.md", "§9.1")]


def test_unterminated_frontmatter_is_9_1(tmp_path: Path):
    _write(tmp_path / "t.md", "---\ntype: BigQuery Table\nstill in frontmatter\n")
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§9.1"


def test_non_mapping_frontmatter_is_9_1(tmp_path: Path):
    _write(tmp_path / "t.md", "---\n- a\n- b\n---\nbody\n")
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§9.1"


def test_out_of_range_timestamp_is_9_1_not_a_crash(tmp_path: Path):
    # PyYAML's implicit resolver raises a *bare* ValueError on an out-of-range
    # date; the checker must report §9.1, not propagate the exception.
    _write(
        tmp_path / "t.md",
        "---\ntype: BigQuery Table\ntimestamp: 2026-13-45\n---\nbody\n",
    )
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§9.1"


# --- §9.2: non-empty type -------------------------------------------------


def test_missing_type_is_9_2(tmp_path: Path):
    _write(tmp_path / "t.md", "---\ntitle: No type here\n---\nbody\n")
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§9.2"


def test_empty_type_is_9_2(tmp_path: Path):
    _write(tmp_path / "t.md", "---\ntype: ''\ntitle: Empty type\n---\nbody\n")
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§9.2"


def test_non_string_type_is_9_2(tmp_path: Path):
    # SPEC §4.1: `type` is "a short string". A non-string value (here an int)
    # does not satisfy §9.2 even though it is technically non-empty.
    _write(tmp_path / "t.md", "---\ntype: 123\ntitle: T\n---\nbody\n")
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§9.2"


def test_valid_concept_passes(tmp_path: Path):
    _write(tmp_path / "t.md", "---\ntype: BigQuery Table\ntitle: T\n---\nbody\n")
    assert check_bundle(tmp_path) == []


# --- §6 / §11: index.md frontmatter --------------------------------------


def test_subdir_index_with_frontmatter_is_6(tmp_path: Path):
    _write(tmp_path / "tables" / "index.md", "---\ntype: Index\n---\n# Tables\n")
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§6"


def test_index_without_frontmatter_passes(tmp_path: Path):
    _write(tmp_path / "index.md", "# Bundle\n- tables/x\n")
    _write(tmp_path / "tables" / "index.md", "# Tables\n- x\n")
    assert check_bundle(tmp_path) == []


def test_root_index_okf_version_only_passes(tmp_path: Path):
    _write(tmp_path / "index.md", "---\nokf_version: '0.1'\n---\n# Bundle\n")
    assert check_bundle(tmp_path) == []


def test_root_index_extra_key_is_11(tmp_path: Path):
    _write(
        tmp_path / "index.md",
        "---\nokf_version: '0.1'\ntype: Bundle\n---\n# Bundle\n",
    )
    violations = check_bundle(tmp_path)
    assert len(violations) == 1 and violations[0].rule == "§11"


# --- reserved log.md is accepted as-is ------------------------------------


def test_log_md_is_not_checked(tmp_path: Path):
    # log.md is reserved (§7). Its date-heading structure is intentionally not
    # validated (that needs a full markdown parser), so even a non-ISO heading
    # is accepted as-is and never reported as a concept (§9.1/§9.2) violation.
    _write(tmp_path / "log.md", "# Log\n\n## not-a-date\nan entry\n")
    assert check_bundle(tmp_path) == []


# --- --strict producer-level keys (§4.1) ----------------------------------


def test_strict_flags_missing_recommended_keys(tmp_path: Path):
    _write(tmp_path / "t.md", "---\ntype: BigQuery Table\n---\nbody\n")
    # §9 alone passes (type is present)...
    assert check_bundle(tmp_path) == []
    # ...but strict mode flags the missing recommended keys.
    violations = check_bundle(tmp_path, strict=True)
    assert len(violations) == 1 and violations[0].rule == "§4.1"
    assert "title" in violations[0].message
    assert "description" in violations[0].message
    assert "timestamp" in violations[0].message


# --- misc -----------------------------------------------------------------


def test_missing_bundle_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        check_bundle(tmp_path / "does-not-exist")


def test_cli_missing_bundle_exits_2_without_traceback(tmp_path: Path, capsys):
    # A bad --bundle path must produce a clean one-line error (exit 2), not a
    # raw Python traceback.
    from reference_agent.cli import main

    rc = main(["validate", "--bundle", str(tmp_path / "nope")])
    err = capsys.readouterr().err
    assert rc == 2
    assert err.startswith("Error:")
    assert "Traceback" not in err


def test_directory_named_md_is_skipped(tmp_path: Path):
    # rglob("*.md") also matches a directory whose name ends in '.md'; it must
    # not be read as a file and reported as a spurious violation.
    (tmp_path / "weird.md").mkdir()
    _write(tmp_path / "weird.md" / "child.md", "---\ntype: Table\n---\nbody\n")
    assert check_bundle(tmp_path) == []


def test_violation_str():
    v = Violation("tables/x.md", "§9.2", "missing or empty 'type' field")
    assert str(v) == "tables/x.md: [§9.2] missing or empty 'type' field"
