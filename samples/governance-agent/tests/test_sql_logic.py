class TransformationEnricher:
    @staticmethod
    def describe_sql_logic(expr: str | None) -> str:
        """Converts SQL expression into natural language hint."""
        if not expr:
            return ""

        expr_upper = expr.upper()

        # 1. Type Conversion
        if "CAST(" in expr_upper or "SAFE_CAST(" in expr_upper:
            return " (Converted data type)"

        # 2. Null Handling
        if any(kw in expr_upper for kw in ["COALESCE(", "IFNULL(", "NULLIF("]):
            return " (Handles missing values)"

        # 3. Numerical Operations
        if any(
            kw in expr_upper for kw in ["ROUND(", "CEIL(", "FLOOR(", "TRUNC("]
        ):
            return " (Numerical rounding applied)"
        if any(op in expr for op in ["*", "/", "+", "-"]) and any(
            char.isdigit() for char in expr
        ):
            return " (Value adjustment applied)"

        # 4. String Formatting
        if any(
            kw in expr_upper
            for kw in ["UPPER(", "LOWER(", "TRIM(", "CONCAT(", "SUBSTR("]
        ):
            return " (String formatting applied)"

        # 5. Date/Time Extractions
        if "EXTRACT(" in expr_upper:
            return " (Date/Time component extracted)"

        # 6. Logical Branching
        if "CASE" in expr_upper or "IF(" in expr_upper:
            return " (Conditional logic applied)"

        # 7. Safe Execution
        if "SAFE." in expr_upper:
            return " (Safe execution applied)"

        return f" (Calculated via logic: `{expr}`)"


def test_describe_sql_logic():
    test_cases = [
        ("CAST(col AS STRING)", " (Converted data type)"),
        ("SAFE_CAST(col AS INT64)", " (Converted data type)"),
        ("COALESCE(col1, col2)", " (Handles missing values)"),
        ("IFNULL(col, 0)", " (Handles missing values)"),
        ("ROUND(price, 2)", " (Numerical rounding applied)"),
        ("CEIL(amount)", " (Numerical rounding applied)"),
        ("price * 1.1", " (Value adjustment applied)"),
        ("amount - 5", " (Value adjustment applied)"),
        ("UPPER(name)", " (String formatting applied)"),
        ("TRIM(text)", " (String formatting applied)"),
        ("EXTRACT(YEAR FROM date_col)", " (Date/Time component extracted)"),
        ("CASE WHEN col > 0 THEN 1 ELSE 0 END", " (Conditional logic applied)"),
        ("IF(col > 0, 1, 0)", " (Conditional logic applied)"),
        ("SAFE.MY_FUNC(col)", " (Safe execution applied)"),
        ("my_custom_expr", " (Calculated via logic: `my_custom_expr`)"),
    ]

    print("Running tests for describe_sql_logic (isolated)...")
    success = True
    for expr, expected in test_cases:
        actual = TransformationEnricher.describe_sql_logic(expr)
        if actual == expected:
            print(f"[PASS] Input: {expr} -> {actual}")
        else:
            print(
                f"[FAIL] Input: {expr} -> Expected: {expected}, Actual: {actual}"
            )
            success = False

    if success:
        print("\nAll tests passed!")
    else:
        print("\nSome tests failed.")
        import sys

        sys.exit(1)


if __name__ == "__main__":
    test_describe_sql_logic()
