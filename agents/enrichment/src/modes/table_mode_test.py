"""Unit tests for the shared cross-table concepts mechanism (v3's headline diff).

These cover the DETERMINISTIC core of the feature — extraction, aggregation
dedup, per-table block building, and the additive prompt section — that is now
shared by table mode AND context-overlay/hybrid mode. No model tokens are spent:
the one model call inside `_aggregate_concepts` is either short-circuited (<=1
concept) or stubbed.

Run (from the enrichment `src/` dir, under a venv that has the agent deps):

    ~/.kc_venvs/v3/bin/python modes/table_mode_test.py

The test puts `src/` on sys.path itself, so `from modes import table_mode` and
table_mode's own top-level imports (common/engine/tools) resolve.
"""

import asyncio
import os
import sys
import unittest

_SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SRC not in sys.path:
  sys.path.insert(0, _SRC)

from modes import context_overlay_mode  # pylint: disable=g-import-not-at-top
from modes import table_mode  # pylint: disable=g-import-not-at-top


def _c(kind, tables, title, body):
  return {"kind": kind, "tables": tables, "title": title, "body": body}


class BuildSharedConceptBlockTest(unittest.TestCase):

  def test_filters_to_named_table(self):
    concepts = [
        _c("join", ["orders", "users"], "orders→users",
           "orders.user_id references users.id"),
        _c("metric", ["payments"], "revenue", "sum(payments.amount)"),
    ]
    block = table_mode.build_shared_concept_block(concepts, "orders")
    self.assertIn("orders→users", block)
    self.assertNotIn("revenue", block)
    self.assertTrue(block.startswith("- [join] orders→users:"))

  def test_bidirectional_membership(self):
    # A concept tagged [A, B] must surface for BOTH A and B — this is what lets
    # an inbound reference reach the table that the child-side doc never names.
    concepts = [_c("join", ["orders", "users"], "link", "orders.user_id = users.id")]
    self.assertIn("link", table_mode.build_shared_concept_block(concepts, "orders"))
    self.assertIn("link", table_mode.build_shared_concept_block(concepts, "users"))

  def test_none_when_no_match(self):
    concepts = [_c("join", ["a"], "t", "b")]
    self.assertEqual("(none)",
                     table_mode.build_shared_concept_block(concepts, "zzz"))
    self.assertEqual("(none)", table_mode.build_shared_concept_block([], "a"))
    self.assertEqual("(none)", table_mode.build_shared_concept_block(None, "a"))


class CrossTableContextSectionTest(unittest.TestCase):

  def test_carries_additive_contract_and_block(self):
    section = table_mode.cross_table_context_section("- [join] x: y")
    self.assertTrue(section.startswith("CROSS-TABLE SHARED CONTEXT"))
    # The strict "additional, never drop a doc fact" contract must be present —
    # this is what makes v3 >= v2 (never sacrifices a document-grounded fact).
    self.assertIn("STRICTLY ADDITIONAL", section)
    self.assertIn("NEVER drop", section)
    self.assertTrue(section.rstrip().endswith("- [join] x: y"))


class SplitDescriptorConceptsTest(unittest.TestCase):

  def test_strips_block_and_parses(self):
    raw = ('Title: Orders\nSummary: ...\n'
           '<CONCEPTS>[{"kind":"join","tables":["orders","users"],'
           '"title":"o2u","body":"orders.user_id = users.id"}]</CONCEPTS>')
    descriptor, concepts = table_mode._split_descriptor_concepts(
        raw, ["orders", "users"])
    self.assertNotIn("<CONCEPTS>", descriptor)
    self.assertIn("Title: Orders", descriptor)
    self.assertEqual(1, len(concepts))
    self.assertEqual(["orders", "users"], concepts[0]["tables"])

  def test_filters_tables_to_known(self):
    raw = ('<CONCEPTS>[{"kind":"join","tables":["orders","ghost"],'
           '"title":"t","body":"b"}]</CONCEPTS>')
    _d, concepts = table_mode._split_descriptor_concepts(raw, ["orders"])
    self.assertEqual(["orders"], concepts[0]["tables"])

  def test_tolerates_empty_and_malformed(self):
    self.assertEqual([], table_mode._split_descriptor_concepts(
        "no block here", ["a"])[1])
    self.assertEqual([], table_mode._split_descriptor_concepts(
        "<CONCEPTS>[]</CONCEPTS>", ["a"])[1])
    self.assertEqual([], table_mode._split_descriptor_concepts(
        "<CONCEPTS>{not json}</CONCEPTS>", ["a"])[1])


class AggregateConceptsTest(unittest.TestCase):

  def test_dedup_keeps_longest_body_without_model(self):
    # Two docs state the SAME concept (same kind+tables+title) with different
    # body lengths -> dedup collapses to one (longest body) and, being a single
    # concept, short-circuits BEFORE any model call.
    calls = []

    async def _boom(*a, **k):  # must NOT be invoked
      calls.append(1)
      return "{}"

    orig = table_mode.common.generate_text_direct
    table_mode.common.generate_text_direct = _boom
    try:
      docs = [
          {"concepts": [_c("join", ["a", "b"], "t", "short")]},
          {"concepts": [_c("join", ["a", "b"], "t",
                           "a much longer and more complete body")]},
      ]
      out = asyncio.run(table_mode._aggregate_concepts(docs, ["a", "b"], {}))
    finally:
      table_mode.common.generate_text_direct = orig
    self.assertEqual([], calls, "model must not be called for a single concept")
    self.assertEqual(1, len(out))
    self.assertEqual("a much longer and more complete body", out[0]["body"])

  def test_merge_path_filters_out_of_dataset_tables(self):
    # >1 distinct concept -> the merge pass runs; stub it. Tables outside the
    # dataset must be dropped from the merged result.
    async def _stub(_instr, _prompt, _model, _usage):
      return ('{"concepts":[{"kind":"join","tables":["a","ghost"],'
              '"title":"t","body":"b"}]}')

    orig = table_mode.common.generate_text_direct
    table_mode.common.generate_text_direct = _stub
    try:
      docs = [
          {"concepts": [_c("join", ["a"], "t1", "b1")]},
          {"concepts": [_c("metric", ["b"], "t2", "b2")]},
      ]
      out = asyncio.run(table_mode._aggregate_concepts(docs, ["a", "b"], {}))
    finally:
      table_mode.common.generate_text_direct = orig
    self.assertTrue(out)
    for c in out:
      for tbl in c["tables"]:
        self.assertIn(tbl, ["a", "b"])

  def test_empty_when_no_concepts(self):
    self.assertEqual(
        [], asyncio.run(table_mode._aggregate_concepts(
            [{"concepts": []}, {}], ["a"], {})))


class CrossModeParityTest(unittest.TestCase):
  """Guard against drift: context_overlay (and hence hybrid) must build its
  cross-table section through table_mode's shared helpers, not a private copy."""

  def test_overlay_uses_shared_helpers(self):
    path = os.path.join(_SRC, "modes", "context_overlay_mode.py")
    with open(path, encoding="utf-8") as f:
      src = f.read()
    self.assertIn("table_mode.cross_table_context_section(", src)
    self.assertIn("table_mode.build_shared_concept_block(", src)
    self.assertIn("table_mode._aggregate_concepts(", src)


class OverlaySourceEntryNameTest(unittest.TestCase):
  """Overlay entries temporarily link to their REAL 1P BigQuery table via
  resource.name (cl/934005010). Hybrid overlays carry it too (same writer)."""

  def test_fqn_points_to_real_bigquery_table_entry(self):
    name = context_overlay_mode.source_entry_name(
        "myproj", "us-central1", "myds", "orders")
    self.assertEqual(
        name,
        "projects/myproj/locations/us-central1/entryGroups/@bigquery/entries/"
        "bigquery.googleapis.com/projects/myproj/datasets/myds/tables/orders")
    # It is the @bigquery (1P) entry of the exact source table.
    self.assertIn("/entryGroups/@bigquery/", name)
    self.assertTrue(name.endswith("/datasets/myds/tables/orders"))


if __name__ == "__main__":
  unittest.main()
