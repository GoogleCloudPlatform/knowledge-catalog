"""Shared LinkingAgent helper.

Maps BigQuery columns to existing glossary terms and injects column-level
`links.definition` into each `<table>.yaml`. Designed to be called from any
mode (currently glossary_mode and table_mode) after the workspace has been
set up via `kcmd_tools.init_pull_dataset(with_glossary_links=True)` plus a
`kcmd_tools.pull_glossary_as_reference(...)` so that:

  * Glossary terms have been pulled into `catalog/glossaries/.../*.ref.yaml`
    (so `kcmd_tools.list_glossaries(output_dir)` returns the allowed terms).
  * The catalog manifest declares `snapshot.entryLinks: [definition, ...]`
    so existing remote links are present in `<table>.yaml`'s field-level
    `links` (which we use as few-shot governance context).

The function mutates `<table>.yaml` files in place — `kcmd push` afterwards
publishes the new links to Dataplex.
"""

import os
from typing import Optional

import common
import engine
from tools import kcmd_tools
import yaml


def _safe_load_yaml(path: str) -> dict:
  with open(path) as f:
    return yaml.safe_load(f) or {}


def _safe_dump_yaml(data: dict, path: str):
  with open(path, "w") as f:
    yaml.safe_dump(data, f, sort_keys=False)


async def apply_column_linking(
    output_dir: str,
    bq_project: str,
    bq_dataset: str,
    model: str,
    usage_acc: Optional[dict] = None,
) -> int:
  """Runs the LinkingAgent over every table in the dataset and injects the

  discovered column→term mappings into each `<table>.yaml`.

  Returns the total number of new links injected. `usage_acc` (a dict with
  `input`/`output` keys) is mutated to track token usage when provided.
  """
  if usage_acc is None:
    usage_acc = {"input": 0, "output": 0}

  # A. Allowed terms (must be present in workspace, pulled via glossary
  # reference). If empty, linking is impossible — bail loudly.
  existing_entries = kcmd_tools.list_glossaries(output_dir)
  if not existing_entries:
    print(
        "[Linking] ⚠️  No glossary entries found in workspace — skipping."
        " (Did you pull glossary terms before calling apply_column_linking?)"
    )
    return 0

  terms_context = "ALLOWED GLOSSARY TERMS:\n"
  found_terms = False
  for t in existing_entries:
    if t["type"] == "glossaryTerm":
      found_terms = True
      ident = t["fqn"] or t["id"]
      terms_context += (
          f"- FQN: {ident}\n  Name: {t['display_name']}\n  Description:"
          f" {t['description']}\n"
      )
  if not found_terms:
    print("[Linking] ⚠️  No glossary terms found — skipping.")
    return 0

  # B. Existing governance (few-shot) + target tables.
  table_names = kcmd_tools.list_tables(output_dir, bq_project, bq_dataset)
  governance_context = "EXISTING GOVERNANCE (Few-shot samples):\n"
  tables_to_map = []

  for tname in table_names:
    meta = kcmd_tools.read_table_meta(output_dir, bq_project, bq_dataset, tname)
    tables_to_map.append(meta)

    path = os.path.join(
        kcmd_tools._dataset_dir(output_dir, bq_project, bq_dataset),  # pylint: disable=protected-access
        f"{tname}.yaml",
    )
    if not os.path.exists(path):
      continue
    entry_data = _safe_load_yaml(path)

    if "links" in entry_data and "definition" in entry_data["links"]:
      for link in entry_data["links"]["definition"]:
        governance_context += f"- Table: {tname} -> {link['target']}\n"

    schema = entry_data.get("aspects", {}).get(
        "dataplex-types.global.schema", {}
    )
    if not schema:
      schema = entry_data.get("aspects", {}).get("schema", {})

    for field in schema.get("fields", []):
      if "links" in field and "definition" in field["links"]:
        for link in field["links"]["definition"]:
          governance_context += (
              f"- Table: {tname}, Column: {field['name']} -> {link['target']}\n"
          )

  # C. Run LinkingAgent per table and inject results.
  runner = engine.create_linking_runner(model)
  total_injected = 0

  for meta in tables_to_map:
    print(f"[Linking] Mapping columns for table: {meta['table']}...")
    target_schema = kcmd_tools.flatten_table_for_prompt(meta)
    prompt = (
        f"{terms_context}\n\n"
        f"{governance_context}\n\n"
        f"TARGET TABLE SCHEMA:\n{target_schema}\n\n"
        "Analyze the schema and map columns to terms."
    )
    result = await common.run_structured(
        runner, prompt, engine.TableLinkingResult, usage_acc
    )
    if not result or not result.links:
      print(f"[Linking] No new links discovered for {meta['table']}.")
      continue

    print(
        f"[Linking] Discovered {len(result.links)} link(s) for {meta['table']}."
    )

    path = os.path.join(
        kcmd_tools._dataset_dir(output_dir, bq_project, bq_dataset),  # pylint: disable=protected-access
        f"{meta['table']}.yaml",
    )
    entry_data = _safe_load_yaml(path)

    schema_key = "dataplex-types.global.schema"
    if schema_key not in entry_data.get("aspects", {}):
      if "schema" in entry_data.get("aspects", {}):
        schema_key = "schema"
      else:
        print(
            f"[Linking] ⚠️  Schema aspect not found for {meta['table']} —"
            " skipping injection."
        )
        continue

    fields = entry_data["aspects"][schema_key].get("fields", [])
    injected_this_table = 0

    for link in result.links:
      for field in fields:
        if field["name"] != link.column_name:
          continue
        if "links" not in field:
          field["links"] = {}
        if "definition" not in field["links"]:
          field["links"]["definition"] = []
        if any(
            l.get("id") == link.term_fqn or l.get("target") == link.term_fqn
            for l in field["links"]["definition"]
        ):
          break  # already linked

        # Human-readable target: project.location.glossary.term (UID-based;
        # kcmd pull will normalize to display-name form on next pull).
        target = link.term_fqn
        if "/glossaries/" in link.term_fqn:
          parts = link.term_fqn.split("/")
          if len(parts) >= 8 and parts[len(parts) - 2] == "terms":
            target = f"{parts[1]}.{parts[3]}.{parts[5]}.{parts[7]}"
          elif len(parts) >= 6 and parts[len(parts) - 2] == "glossaries":
            target = f"{parts[1]}.{parts[3]}.{parts[5]}"

        field["links"]["definition"].append({
            "target": target,
            "id": link.term_fqn,
        })
        print(f"  [+] Linked {link.column_name} -> {target} ({link.reason})")
        injected_this_table += 1
        break

    if injected_this_table:
      _safe_dump_yaml(entry_data, path)
      total_injected += injected_this_table

  return total_injected
