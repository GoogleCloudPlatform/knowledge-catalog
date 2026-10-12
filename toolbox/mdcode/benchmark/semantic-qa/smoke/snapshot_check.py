"""Second model, to check the traps are not a retail_sales accident.

supply_chain's inventory_snapshot is a daily stock position. Summing it across
dates counts the same stock once per day. This builds three days of positions
and shows what the two readings give.
"""

import sqlite3

con = sqlite3.connect(":memory:")
cur = con.cursor()
cur.executescript("""
CREATE TABLE part (part_id TEXT, part_name TEXT, commodity_group TEXT,
                   standard_cost REAL, safety_stock_units REAL);
CREATE TABLE warehouse (warehouse_id TEXT, warehouse_name TEXT, region TEXT);
CREATE TABLE inventory_snapshot (as_of_date TEXT, warehouse_id TEXT,
                                 part_id TEXT, on_hand_units REAL,
                                 allocated_units REAL, daily_demand_units REAL,
                                 is_stockout INTEGER);
INSERT INTO part VALUES
  ('PT1','Bearing','Fasteners',10.0,50.0),
  ('PT2','Housing','Polymers',25.0,20.0);
INSERT INTO warehouse VALUES ('W1','Reno','West'),('W2','Akron','East');
-- Three consecutive days. The physical stock barely moves; only the number of
-- snapshot rows grows.
INSERT INTO inventory_snapshot VALUES
  ('2026-03-01','W1','PT1',100.0,10.0,5.0,0),
  ('2026-03-01','W1','PT2', 40.0, 5.0,2.0,0),
  ('2026-03-01','W2','PT1', 60.0, 0.0,3.0,0),
  ('2026-03-02','W1','PT1',100.0,10.0,5.0,0),
  ('2026-03-02','W1','PT2', 40.0, 5.0,2.0,0),
  ('2026-03-02','W2','PT1', 60.0, 0.0,3.0,0),
  ('2026-03-03','W1','PT1', 98.0,10.0,5.0,0),
  ('2026-03-03','W1','PT2', 40.0, 5.0,2.0,0),
  ('2026-03-03','W2','PT1',  0.0, 0.0,3.0,1);
""")

LATEST = "(SELECT MAX(as_of_date) FROM inventory_snapshot)"

CASES = [
    (
        "q07 inventory value (snapshot read at one date)",
        f"""SELECT SUM(i.on_hand_units * p.standard_cost)
         FROM inventory_snapshot i JOIN part p ON i.part_id = p.part_id
         WHERE i.as_of_date = {LATEST}""",
        """SELECT SUM(i.on_hand_units * p.standard_cost)
        FROM inventory_snapshot i JOIN part p ON i.part_id = p.part_id""",
    ),
    (
        "q09 parts below safety stock",
        f"""SELECT COUNT(DISTINCT i.part_id)
         FROM inventory_snapshot i JOIN part p ON i.part_id = p.part_id
         WHERE i.as_of_date = {LATEST}
           AND i.on_hand_units < p.safety_stock_units""",
        """SELECT COUNT(DISTINCT i.part_id)
        FROM inventory_snapshot i JOIN part p ON i.part_id = p.part_id
        WHERE i.on_hand_units < p.safety_stock_units""",
    ),
    (
        "q10 days of supply, part PT1",
        f"""SELECT SUM(on_hand_units)/NULLIF(SUM(daily_demand_units),0)
         FROM inventory_snapshot
         WHERE part_id='PT1' AND as_of_date = {LATEST}""",
        """SELECT SUM(on_hand_units)/NULLIF(SUM(daily_demand_units),0)
        FROM inventory_snapshot WHERE part_id='PT1'""",
    ),
    (
        "q11 stockout rate (correctly measured ACROSS dates)",
        """SELECT CAST(SUM(is_stockout) AS REAL)/COUNT(*) FROM inventory_snapshot""",
        """SELECT CAST(SUM(is_stockout) AS REAL)/COUNT(*) FROM inventory_snapshot
        WHERE as_of_date = (SELECT MAX(as_of_date) FROM inventory_snapshot)""",
    ),
]

print("--- supply_chain snapshot traps ---")
bit = 0
for label, right_sql, wrong_sql in CASES:
  right = cur.execute(right_sql).fetchone()[0]
  wrong = cur.execute(wrong_sql).fetchone()[0]
  diverged = right != wrong
  bit += diverged
  print(f"\n  {label}")
  print(f"    correct : {right}")
  print(f"    naive   : {wrong}")
  print(f"    -> {'DIVERGES' if diverged else 'IDENTICAL'}")
print(f"\n{bit}/{len(CASES)} diverge")
