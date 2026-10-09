import pytest

from policy_as_code_agent.simulation import run_simulation, validate_code_safety


def test_safe_code():
    code = """
def check_policy(metadata):
    return []
"""
    errors = validate_code_safety(code)
    assert errors == []


def test_creative_policy_execution():
    code = """
import re
import datetime
import math
from collections import defaultdict, Counter
from typing import List, Dict, Any

def _is_snake_case(name: str) -> bool:
    return bool(re.match(r'^[a-z0-9_]+$', name))

def check_policy(metadata: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    violations = []
    dataset_counts = Counter()
    for _, entry in enumerate(metadata):
        fqn = entry.get("fullyQualifiedName", "unknown")
        display_name = entry.get("entrySource", {}).get("displayName", "")
        dataset_counts[display_name] += 1
        try:
            if display_name and not _is_snake_case(display_name):
                violations.append({
                    "resource_name": fqn,
                    "violation": f"Display name '{display_name}' is not snake_case."
                })
        except (ValueError, KeyError, TypeError):
            continue
    return violations
"""
    assert validate_code_safety(code) == []
    sample_metadata = [
        {
            "fullyQualifiedName": "bigquery:proj.ds.BadTableName",
            "entrySource": {"displayName": "BadTableName"},
        },
        {
            "fullyQualifiedName": "bigquery:proj.ds.good_table_name",
            "entrySource": {"displayName": "good_table_name"},
        },
    ]
    violations = run_simulation(code, sample_metadata)
    assert len(violations) == 1
    assert violations[0]["resource_name"] == "bigquery:proj.ds.BadTableName"


@pytest.mark.parametrize(
    "code",
    [
        "import os",
        "import sys",
        "import subprocess",
        "from os import path",
        "import requests",
        "import builtins",
        "import ctypes",
        "import posix",
        "from re import __builtins__",
    ],
)
def test_unsafe_imports(code):
    errors = validate_code_safety(code)
    assert len(errors) > 0, f"Expected error for: {code}"
    assert "Security Violation" in errors[0]


@pytest.mark.parametrize(
    "code",
    [
        "eval('print(1)')",
        "exec('print(1)')",
        "open('/etc/passwd')",
        "compile('print(1)', '', 'exec')",
        "f = __import__; f('os').system('echo pwned')",
        "imp = __import__\nimp('subprocess')",
        "g = getattr(re, '__builtins__')",
        "x = ().__class__.__base__.__subclasses__()",
        "y = re.match.__globals__['__builtins__']",
    ],
)
def test_unsafe_builtins_and_aliasing(code):
    errors = validate_code_safety(code)
    assert len(errors) > 0, f"Expected error for: {code}"
    assert "Security Violation" in errors[0]


def test_run_simulation_blocks_aliased_import_rce():
    malicious_code = """
def check_policy(metadata):
    f = __import__
    os_mod = f('os')
    os_mod.system('echo pwned')
    return []
"""
    violations = run_simulation(malicious_code, [])
    assert len(violations) > 0
    assert violations[0]["policy"] == "Security Violation"
    assert "Security Violation" in violations[0]["violation"]

