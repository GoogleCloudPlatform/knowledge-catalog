"""Does the benchmark actually discriminate?

Loads benchmark/semantic-qa/models/retail_sales.yaml, builds a SQLite database
whose views are generated FROM THE MODEL'S OWN FIELD EXPRESSIONS, loads a small
hand-checkable fixture, then for each trap question runs the correct query
beside the naive one a text-to-SQL system would plausibly emit.

A trap is only a trap if the two disagree. This prints both and the gap.

Run:  python3 -I benchmark/semantic-qa/smoke/trap_check.py
"""

import os
import re
import sqlite3
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.path.join(HERE, "..", "models", "retail_sales.yaml")
)
SQL_WORDS = {
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "SUM",
    "COUNT",
    "DISTINCT",
    "NULLIF",
    "MAX",
    "MIN",
    "AVG",
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "NULL",
    "CAST",
    "AS",
}


def ansi(expr_block):
  for d in (expr_block or {}).get("dialects", []):
    if d["dialect"] == "ANSI_SQL":
      return d["expression"]
  return None


def physical_columns(expression):
  """Identifiers a field expression reads, minus string literals and keywords."""
  stripped = re.sub(r"'[^']*'", " ", expression)
  out = []
  for tok in re.findall(r"[A-Za-z_]\w*", stripped):
    if tok.upper() in SQL_WORDS or tok in out:
      continue
    out.append(tok)
  return out


doc = yaml.safe_load(open(MODEL))
model = doc["semantic_model"][0]
datasets = model.get("datasets") or model.get("entities")

con = sqlite3.connect(":memory:")
cur = con.cursor()

# One raw table per dataset, columns derived from the model's expressions, then
# one view exposing the logical field names. Executing the view IS executing the
# model's field SQL.
# Numeric columns are declared REAL on purpose. SQLite truncates INTEGER /
# INTEGER to an integer, which would flatten every ratio metric to 0; BigQuery
# and Spanner both return a float for the same division. REAL affinity makes
# this harness agree with the warehouses the models actually target, so a zero
# here means a modelling bug rather than a SQLite rule.
NUMERIC = {"Decimal", "Float", "Integer"}

raw_cols = {}
for ds in datasets:
  cols, projections, numeric = [], [], set()
  for f in ds.get("fields", []):
    expr = ansi(f.get("expression"))
    if expr is None:
      continue
    for c in physical_columns(expr):
      if c not in cols:
        cols.append(c)
    if f.get("datatype") in NUMERIC:
      # A field that IS a bare column name types that column.
      if expr.strip() == f["name"]:
        numeric.add(f["name"])
    projections.append(f'{expr} AS "{f["name"]}"')
  # A computed field's operands inherit numeric affinity from the arithmetic.
  for f in ds.get("fields", []):
    expr = ansi(f.get("expression")) or ""
    if f.get("datatype") in NUMERIC and re.search(r"[*/+-]", expr):
      numeric.update(physical_columns(expr))
  raw_cols[ds["name"]] = cols
  decls = [f"{c} REAL" if c in numeric else c for c in cols]
  cur.execute(f'CREATE TABLE raw_{ds["name"]} ({", ".join(decls)})')
  cur.execute(
      f'CREATE VIEW {ds["name"]} AS SELECT {", ".join(projections)} '
      f'FROM raw_{ds["name"]}'
  )

print(f"built {len(datasets)} views from the model's own field expressions")
for name in sorted(raw_cols):
  print(f"  {name:<22} physical columns: {', '.join(raw_cols[name])}")

# --- fixture, small enough to check by hand ---------------------------------
FIXTURE = {
    "store": [
        dict(
            store_id="S1",
            store_name="Market St",
            region="West",
            state="CA",
            square_feet=1000,
            employee_count=10,
            opened_date="2020-01-01",
        ),
        dict(
            store_id="S2",
            store_name="Bay Plaza",
            region="West",
            state="CA",
            square_feet=2000,
            employee_count=20,
            opened_date="2021-01-01",
        ),
        dict(
            store_id="S3",
            store_name="Hudson",
            region="East",
            state="NY",
            square_feet=500,
            employee_count=5,
            opened_date="2022-01-01",
        ),
    ],
    "customer": [
        dict(
            customer_id="C1",
            first_name="Ann",
            last_name="Lee",
            loyalty_tier="GOLD",
            signup_date="2024-01-01",
            home_state="CA",
            email_opt_in=1,
        ),
        dict(
            customer_id="C2",
            first_name="Bo",
            last_name="Ray",
            loyalty_tier="NONE",
            signup_date="2025-01-01",
            home_state="NY",
            email_opt_in=0,
        ),
        dict(
            customer_id="C3",
            first_name="Cy",
            last_name="Kim",
            loyalty_tier="PLATINUM",
            signup_date="2023-01-01",
            home_state="CA",
            email_opt_in=1,
        ),
    ],
    "product": [
        dict(
            product_id="P1",
            product_name="Widget",
            category="Electronics",
            subcategory="Gadgets",
            brand="BrandA",
            list_price=100,
        ),
        dict(
            product_id="P2",
            product_name="Gizmo",
            category="Electronics",
            subcategory="Gadgets",
            brand="BrandB",
            list_price=50,
        ),
        dict(
            product_id="P3",
            product_name="Shirt",
            category="Apparel",
            subcategory="Tops",
            brand="BrandA",
            list_price=20,
        ),
    ],
    "calendar_date": [
        dict(
            date_value="2026-01-05",
            fiscal_year=2026,
            fiscal_quarter="FY2026-Q1",
            month_start="2026-01-01",
            day_of_week="Mon",
            is_holiday=0,
        ),
        dict(
            date_value="2026-01-06",
            fiscal_year=2026,
            fiscal_quarter="FY2026-Q1",
            month_start="2026-01-01",
            day_of_week="Tue",
            is_holiday=1,
        ),
        dict(
            date_value="2026-02-10",
            fiscal_year=2026,
            fiscal_quarter="FY2026-Q1",
            month_start="2026-02-01",
            day_of_week="Tue",
            is_holiday=0,
        ),
        dict(
            date_value="2026-02-11",
            fiscal_year=2026,
            fiscal_quarter="FY2026-Q1",
            month_start="2026-02-01",
            day_of_week="Wed",
            is_holiday=0,
        ),
    ],
    "sales_order": [
        dict(
            order_id="O1",
            customer_id="C1",
            store_id="S1",
            order_date="2026-01-05",
            channel="WEB",
            order_status="PLACED",
            shipping_amount=5,
        ),
        dict(
            order_id="O2",
            customer_id="C2",
            store_id="S1",
            order_date="2026-01-06",
            channel="STORE",
            order_status="PLACED",
            shipping_amount=0,
        ),
        dict(
            order_id="O3",
            customer_id="C3",
            store_id="S2",
            order_date="2026-02-10",
            channel="WEB",
            order_status="PLACED",
            shipping_amount=10,
        ),
        dict(
            order_id="O4",
            customer_id="C1",
            store_id="S3",
            order_date="2026-02-11",
            channel="STORE",
            order_status="PLACED",
            shipping_amount=0,
        ),
    ],
    # ext = qty*price. L1..L3 on O1, L4 on O2, L5..L6 on O3, L7 on O4.
    "order_line": [
        dict(
            order_line_id="L1",
            order_id="O1",
            line_number=1,
            product_id="P1",
            quantity=2,
            unit_price=100,
            discount_amount=20,
            unit_cost=60,
            returned_quantity=0,
        ),
        dict(
            order_line_id="L2",
            order_id="O1",
            line_number=2,
            product_id="P2",
            quantity=1,
            unit_price=50,
            discount_amount=0,
            unit_cost=30,
            returned_quantity=0,
        ),
        dict(
            order_line_id="L3",
            order_id="O1",
            line_number=3,
            product_id="P3",
            quantity=3,
            unit_price=20,
            discount_amount=5,
            unit_cost=8,
            returned_quantity=1,
        ),
        dict(
            order_line_id="L4",
            order_id="O2",
            line_number=1,
            product_id="P1",
            quantity=1,
            unit_price=100,
            discount_amount=0,
            unit_cost=60,
            returned_quantity=0,
        ),
        dict(
            order_line_id="L5",
            order_id="O3",
            line_number=1,
            product_id="P2",
            quantity=4,
            unit_price=50,
            discount_amount=10,
            unit_cost=30,
            returned_quantity=0,
        ),
        dict(
            order_line_id="L6",
            order_id="O3",
            line_number=2,
            product_id="P3",
            quantity=2,
            unit_price=20,
            discount_amount=0,
            unit_cost=8,
            returned_quantity=0,
        ),
        dict(
            order_line_id="L7",
            order_id="O4",
            line_number=1,
            product_id="P1",
            quantity=1,
            unit_price=100,
            discount_amount=10,
            unit_cost=60,
            returned_quantity=0,
        ),
    ],
    "promotion": [
        dict(
            promotion_id="PR1",
            promotion_name="Spring Sale",
            promotion_type="PERCENT_OFF",
            start_date="2026-01-01",
            end_date="2026-03-31",
            funding_source="VENDOR",
        ),
        dict(
            promotion_id="PR2",
            promotion_name="Loyalty Bonus",
            promotion_type="LOYALTY_ONLY",
            start_date="2026-01-01",
            end_date="2026-12-31",
            funding_source="RETAILER",
        ),
    ],
    # L1 stacks two promotions; its 20 of discount splits 12/8.
    "order_line_promotion": [
        dict(order_line_id="L1", promotion_id="PR1", allocated_discount=12),
        dict(order_line_id="L1", promotion_id="PR2", allocated_discount=8),
        dict(order_line_id="L3", promotion_id="PR1", allocated_discount=5),
        dict(order_line_id="L5", promotion_id="PR1", allocated_discount=10),
        dict(order_line_id="L7", promotion_id="PR2", allocated_discount=10),
    ],
}

for entity, rows in FIXTURE.items():
  cols = raw_cols[entity]
  cur.executemany(
      f'INSERT INTO raw_{entity} ({", ".join(cols)}) '
      f'VALUES ({", ".join("?" * len(cols))})',
      [[r[c] for c in cols] for r in rows],
  )
con.commit()

# --- part 1: does every metric expression actually execute? -----------------
STAR = """
  FROM order_line
  JOIN sales_order   ON order_line.order_id    = sales_order.order_id
  JOIN customer      ON sales_order.customer_id = customer.customer_id
  JOIN store         ON sales_order.store_id    = store.store_id
  JOIN calendar_date ON sales_order.order_date  = calendar_date.date_value
  JOIN product       ON order_line.product_id   = product.product_id
"""
BRIDGE = """
  FROM order_line_promotion
  JOIN order_line ON order_line_promotion.order_line_id = order_line.order_line_id
  JOIN promotion  ON order_line_promotion.promotion_id  = promotion.promotion_id
"""

print("\n--- every metric expression, executed ---")
ran = failed = 0
for m in model["metrics"]:
  expr = ansi(m["expression"])
  frm = BRIDGE if "order_line_promotion" in expr else STAR
  try:
    val = cur.execute(f"SELECT {expr} {frm}").fetchone()[0]
    ran += 1
    shown = f"{val:.4f}" if isinstance(val, float) else val
    print(f"  {m['name']:<24} = {shown}")
  except Exception as exc:  # noqa: BLE001 - we want the message verbatim
    failed += 1
    print(f"  {m['name']:<24} FAILED: {exc}")
print(f"  -> {ran} executed, {failed} failed")

# --- part 2: right query vs the plausible wrong one -------------------------
TRAPS = [
    (
        "q07 orders per store (fan-out)",
        """SELECT store.store_name, COUNT(DISTINCT sales_order.order_id)
        FROM sales_order JOIN store ON sales_order.store_id = store.store_id
        GROUP BY 1 ORDER BY 1""",
        """SELECT store.store_name, COUNT(*)
        FROM order_line
        JOIN sales_order ON order_line.order_id = sales_order.order_id
        JOIN store ON sales_order.store_id = store.store_id
        GROUP BY 1 ORDER BY 1""",
    ),
    (
        "q19 revenue per employee, store S1",
        """SELECT SUM(order_line.quantity*order_line.unit_price
                   - order_line.discount_amount) / MAX(store.employee_count)
        FROM order_line
        JOIN sales_order ON order_line.order_id = sales_order.order_id
        JOIN store ON sales_order.store_id = store.store_id
        WHERE store.store_id = 'S1'""",
        """SELECT SUM(order_line.quantity*order_line.unit_price
                   - order_line.discount_amount) / SUM(store.employee_count)
        FROM order_line
        JOIN sales_order ON order_line.order_id = sales_order.order_id
        JOIN store ON sales_order.store_id = store.store_id
        WHERE store.store_id = 'S1'""",
    ),
    (
        "q15 sales per square foot, West region",
        """SELECT (SELECT SUM(ol.quantity*ol.unit_price - ol.discount_amount)
                FROM order_line ol
                JOIN sales_order so ON ol.order_id = so.order_id
                JOIN store s ON so.store_id = s.store_id
                WHERE s.region='West')
             / (SELECT SUM(square_feet) FROM store WHERE region='West')""",
        """SELECT SUM(order_line.quantity*order_line.unit_price
                   - order_line.discount_amount) / SUM(store.square_feet)
        FROM order_line
        JOIN sales_order ON order_line.order_id = sales_order.order_id
        JOIN store ON sales_order.store_id = store.store_id
        WHERE store.region='West'""",
    ),
    (
        "q08 discount by promotion (many-to-many)",
        """SELECT promotion.promotion_name,
               SUM(order_line_promotion.allocated_discount)
        FROM order_line_promotion
        JOIN promotion ON order_line_promotion.promotion_id = promotion.promotion_id
        GROUP BY 1 ORDER BY 1""",
        """SELECT promotion.promotion_name, SUM(order_line.discount_amount)
        FROM order_line_promotion
        JOIN order_line ON order_line_promotion.order_line_id = order_line.order_line_id
        JOIN promotion ON order_line_promotion.promotion_id = promotion.promotion_id
        GROUP BY 1 ORDER BY 1""",
    ),
    (
        "q09 promoted line count",
        """SELECT COUNT(DISTINCT order_line_promotion.order_line_id)
        FROM order_line_promotion""",
        """SELECT COUNT(*) FROM order_line_promotion""",
    ),
]

print("\n--- trap questions: correct query vs plausible wrong query ---")
bit = 0
for label, right_sql, wrong_sql in TRAPS:
  right = cur.execute(right_sql).fetchall()
  wrong = cur.execute(wrong_sql).fetchall()
  diverged = right != wrong
  bit += diverged
  print(f"\n  {label}")
  print(f"    correct : {right}")
  print(f"    naive   : {wrong}")
  print(
      "    ->"
      f" {'DIVERGES (trap bites)' if diverged else 'IDENTICAL (trap is inert)'}"
  )

print(
    f"\n{bit}/{len(TRAPS)} traps produce a different answer for the wrong query"
)
