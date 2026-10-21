import ast
import collections
import copy
import datetime
import difflib
import functools
import ipaddress
import itertools
import json
import math
import re
import statistics
import string
import types
import typing
import unicodedata
import uuid

# Safe standard library modules allowed for policy evaluation
SAFE_MODULES = {
    "collections": collections,
    "copy": copy,
    "datetime": datetime,
    "difflib": difflib,
    "functools": functools,
    "ipaddress": ipaddress,
    "itertools": itertools,
    "json": json,
    "math": math,
    "re": re,
    "statistics": statistics,
    "string": string,
    "typing": types.SimpleNamespace(
        Any=typing.Any,
        Callable=typing.Callable,
        Dict=typing.Dict,
        Iterable=typing.Iterable,
        List=typing.List,
        Optional=typing.Optional,
        Sequence=typing.Sequence,
        Set=typing.Set,
        Tuple=typing.Tuple,
        Union=typing.Union,
    ),
    "unicodedata": unicodedata,
    "uuid": uuid,
}

# Explicitly restricted modules
UNSAFE_MODULES = {
    "os",
    "sys",
    "subprocess",
    "shutil",
    "pickle",
    "importlib",
    "socket",
    "http",
    "urllib",
    "requests",
    "builtins",
    "ctypes",
    "posix",
    "nt",
    "pty",
    "marshal",
    "io",
    "pathlib",
    "tempfile",
    "inspect",
    "gc",
    "operator",
    "runpy",
    "code",
}

# Restricted built-in functions and identifiers (blocked both in direct calls and variable references/aliasing)
UNSAFE_IDENTIFIERS = {
    "eval",
    "exec",
    "open",
    "compile",
    "__import__",
    "__builtins__",
    "__loader__",
    "__spec__",
    "builtins",
    "getattr",
    "setattr",
    "delattr",
    "globals",
    "locals",
    "vars",
    "dir",
    "input",
    "breakpoint",
    "help",
    "memoryview",
}

# Restricted frame/function introspection attributes
UNSAFE_ATTRIBUTES = {
    "func_globals",
    "func_code",
    "func_closure",
    "gi_frame",
    "gi_code",
    "cr_frame",
    "cr_code",
    "ag_frame",
    "ag_code",
    "f_globals",
    "f_locals",
    "f_builtins",
    "f_back",
    "f_code",
}


class _SafeImportResolver(ast.NodeTransformer):
    """
    Resolves validated safe import statements directly into safe_globals
    and strips the import AST nodes so that __import__ is never needed
    in safe_globals['__builtins__'].
    """

    def __init__(self, target_globals: dict):
        self.target_globals = target_globals

    def visit_Import(self, node: ast.Import) -> ast.AST:
        for alias in node.names:
            if alias.name not in SAFE_MODULES:
                raise ImportError(
                    f"Security Violation: Import of restricted module '{alias.name}' is not allowed."
                )
            bound_name = alias.asname or alias.name.split(".")[0]
            self.target_globals[bound_name] = SAFE_MODULES[alias.name]
        return ast.copy_location(ast.Pass(), node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> ast.AST:
        if not node.module or node.module not in SAFE_MODULES or node.level:
            raise ImportError(
                f"Security Violation: Import from restricted module '{node.module}' is not allowed."
            )
        mod = SAFE_MODULES[node.module]
        for alias in node.names:
            if alias.name == "*" or alias.name.startswith("_"):
                raise ImportError(
                    f"Security Violation: Import of '{alias.name}' from '{node.module}' is not allowed."
                )
            if not hasattr(mod, alias.name):
                raise ImportError(
                    f"Cannot import name '{alias.name}' from '{node.module}'"
                )
            bound_name = alias.asname or alias.name
            self.target_globals[bound_name] = getattr(mod, alias.name)
        return ast.copy_location(ast.Pass(), node)


def validate_code_safety(code: str) -> list:
    """
    Analyzes the code using AST to detect potentially unsafe operations.
    Returns a list of error messages if unsafe patterns are found.
    """
    errors = []

    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Syntax Error in generated code: {e}"]

    for node in ast.walk(tree):
        # 1. Check imports against both denylist and allowlist
        if isinstance(node, ast.Import):
            for alias in node.names:
                root_mod = alias.name.split(".")[0]
                if root_mod in UNSAFE_MODULES or alias.name not in SAFE_MODULES:
                    errors.append(
                        f"Security Violation: Import of restricted module '{alias.name}' is not allowed."
                    )

        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                errors.append(
                    "Security Violation: Relative imports are not allowed."
                )
            elif not node.module:
                errors.append(
                    "Security Violation: Empty module import is not allowed."
                )
            else:
                root_mod = node.module.split(".")[0]
                if root_mod in UNSAFE_MODULES or node.module not in SAFE_MODULES:
                    errors.append(
                        f"Security Violation: Import from restricted module '{node.module}' is not allowed."
                    )
                for alias in node.names:
                    if alias.name == "*" or alias.name.startswith("_"):
                        errors.append(
                            f"Security Violation: Import of '{alias.name}' from '{node.module}' is not allowed."
                        )

        # 2. Check direct function calls
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                if node.func.id in UNSAFE_IDENTIFIERS:
                    errors.append(
                        f"Security Violation: Usage of restricted function '{node.func.id}' is not allowed."
                    )

        # 3. Check identifier references to prevent aliasing (e.g., f = __import__) and dunder access
        elif isinstance(node, ast.Name):
            if node.id in UNSAFE_IDENTIFIERS:
                errors.append(
                    f"Security Violation: Reference to restricted identifier '{node.id}' is not allowed."
                )
            elif node.id.startswith("__") and node.id != "__name__":
                errors.append(
                    f"Security Violation: Usage of dunder identifier '{node.id}' is not allowed."
                )

        # 4. Check attribute access to prevent dunder/sandbox escape (e.g., __globals__, __class__, __subclasses__)
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") or node.attr in UNSAFE_ATTRIBUTES:
                errors.append(
                    f"Security Violation: Access to restricted attribute '{node.attr}' is not allowed."
                )

    # Deduplicate while preserving order
    return list(dict.fromkeys(errors))


def run_simulation(policy_code: str, metadata: list) -> list:
    violations = []
    if not policy_code or policy_code.startswith("# API key not configured"):
        violations.append(
            {"policy": "Configuration Error", "violation": policy_code}
        )
        return violations

    if policy_code.startswith("# Error:"):
        violations.append(
            {"policy": "Execution Error", "violation": policy_code}
        )
        return violations

    # 1. Static Security Analysis
    security_errors = validate_code_safety(policy_code)
    if security_errors:
        for err in security_errors:
            violations.append(
                {"policy": "Security Violation", "violation": err}
            )
        return violations

    # 2. Prepare Restricted Environment
    # Only allow specific safe modules and built-ins (__import__ is NOT exposed in __builtins__)
    safe_globals = {
        "__builtins__": {
            "abs": abs,
            "all": all,
            "any": any,
            "ascii": ascii,
            "bin": bin,
            "bool": bool,
            "bytes": bytes,
            "callable": callable,
            "chr": chr,
            "complex": complex,
            "dict": dict,
            "divmod": divmod,
            "enumerate": enumerate,
            "filter": filter,
            "float": float,
            "format": format,
            "frozenset": frozenset,
            "hash": hash,
            "hasattr": hasattr,
            "hex": hex,
            "int": int,
            "isinstance": isinstance,
            "issubclass": issubclass,
            "iter": iter,
            "len": len,
            "list": list,
            "map": map,
            "max": max,
            "min": min,
            "next": next,
            "oct": oct,
            "ord": ord,
            "pow": pow,
            "range": range,
            "repr": repr,
            "reversed": reversed,
            "round": round,
            "set": set,
            "slice": slice,
            "sorted": sorted,
            "str": str,
            "sum": sum,
            "tuple": tuple,
            "zip": zip,
            # Standard exception classes for try/except in policy logic
            "Exception": Exception,
            "ValueError": ValueError,
            "TypeError": TypeError,
            "KeyError": KeyError,
            "IndexError": IndexError,
            "AttributeError": AttributeError,
            "StopIteration": StopIteration,
            "ZeroDivisionError": ZeroDivisionError,
        },
        **SAFE_MODULES,
    }

    try:
        # Parse and resolve safe imports into safe_globals without exposing __import__
        tree = ast.parse(policy_code)
        tree = _SafeImportResolver(safe_globals).visit(tree)
        ast.fix_missing_locations(tree)

        # The generated code should define a function named check_policy
        # that takes metadata as an argument.
        # We execute the AST in the restricted namespace.
        exec(compile(tree, filename="<policy_code>", mode="exec"), safe_globals)

        if "check_policy" in safe_globals and callable(
            safe_globals["check_policy"]
        ):
            # The generated function returns a list of violations
            check_policy_func = safe_globals["check_policy"]
            violations = check_policy_func(metadata)
        else:
            violations.append(
                {
                    "policy": "Execution Error",
                    "violation": "Error executing policy code: 'check_policy' function not found.",
                }
            )
    except Exception as e:
        violations.append(
            {
                "policy": "Execution Error",
                "violation": f"Error executing policy code: {e}",
            }
        )

    return violations


