"""Multi-turn refinement for the enrichment agent.

After the initial enrichment finishes, the customer can refine the output with
free-text feedback. An LLM dispatcher (engine.create_refinement_dispatch_runner)
maps each request to a structured plan, and we re-run ONLY the affected work —
reusing the context that was already loaded during the initial run. Crucially,
refinement NEVER re-reads the source docs or re-pulls the dataset: each entry
carries the exact grounding prompt that produced its overview, so a rewrite is
just one more writer call.

Two surfaces consume this module:
  * CLI: `agent_runner --interactive` keeps the process alive at a `refine>`
    REPL (run_repl), holding the EnrichmentSession in memory.
  * Webapp: stdin can't be wired into the streamed subprocess, so refinement
    uses PERSIST + RE-INVOKE. The initial run saves the session to
    `<output_dir>/refine_session.json` (save_session); each "Refine" click
    spawns `agent_runner --refine_instruction=...`, which rehydrates the session
    (load_session), applies ONE turn (run_one_refinement), and exits.

The session model is mode-agnostic: every mode (table / context_overlay / doc)
populates an EnrichmentSession of plain-data EntryState objects at the end of its
run(). Each EntryState records the absolute path of its overview sidecar
(`overview_path`), so refine.py rewrites it directly without per-mode knowledge —
and the whole session serializes to JSON (no closures).

First version supports two operations (see engine.RefinementPlan):
  * rewrite — re-generate selected (or all) entries' overviews with a change.
  * answer  — respond to a question about the output; no files change.
"""

import asyncio
import dataclasses
from dataclasses import dataclass, field
import json
import os
import sys

import common
from engine import (
    REFINEMENT_WRITER_INSTRUCTION,
    RefinementPlan,
    create_refinement_dispatch_runner,
)

# Saved next to the generated mdcode so a later `--refine_instruction` invocation
# (webapp) can rehydrate the session without re-running the pipeline.
SESSION_FILE = "refine_session.json"


@dataclass
class EntryState:
  """Everything needed to refine ONE entry without re-ingesting anything.

  Pure data (no closures) so the whole session serializes to JSON.
  """

  entry_id: str
  display_name: str
  description: str
  category_id: str
  # The exact writer user-prompt built during the initial run. Already contains
  # the topic, the entry's metadata/schema, and the routed source-doc content —
  # so refinement reuses it verbatim and never re-reads docs.
  grounding_prompt: str
  writer_model: str
  # Current overview body (mutated each refine turn).
  overview_body: str
  # Absolute path of the `.overview.md` sidecar this entry owns; a refinement
  # overwrites exactly this file (the entry YAML is unchanged by content edits).
  overview_path: str
  # Distilled instructions applied so far (oldest first).
  refinement_history: list[str] = field(default_factory=list)
  # 'kb' (doc mode, discovered) or 'table' (table/overlay, seeded from the
  # dataset). Used to re-seed enumeration on a `reenumerate` refinement turn.
  kind: str = "kb"

  def write(self, body: str) -> list[str]:
    """Overwrite the overview sidecar with `body`; returns the path written."""
    if not self.overview_path:
      return []
    os.makedirs(os.path.dirname(self.overview_path), exist_ok=True)
    with open(self.overview_path, "w") as f:
      f.write(common.clean_overview_body(body) + "\n")
    return [self.overview_path]


@dataclass
class EnrichmentSession:
  """State carried from the initial run into refinement (in-memory or on disk)."""

  mode: str
  topic: str
  model: str
  output_dir: str
  entries: dict[str, EntryState]
  usage_acc: dict
  # Args to re-persist trajectory.json after a refine turn (see _persist).
  traj_meta: dict = field(default_factory=dict)
  # Refinement turns recorded for trajectory.json.
  refinements: list[dict] = field(default_factory=list)
  # Phase-2 (enumeration) state, so a `reenumerate` refinement can re-run
  # enumeration over the SAME context and add/remove/recategorize entries
  # without re-reading any source. enum_context is the exact compiled context
  # the initial run fed to common.run_enumeration; writer_params holds the
  # mode-specific bits needed to materialize new/moved entries (see each mode's
  # apply_reenumeration). Empty on sessions saved before this feature.
  enum_context: str = ""
  writer_params: dict = field(default_factory=dict)


def session_path(output_dir: str) -> str:
  return os.path.join(output_dir, SESSION_FILE)


def save_session(session: EnrichmentSession) -> None:
  """Persist the session to `<output_dir>/refine_session.json` (webapp re-invoke).

  Safe no-op without an output_dir. usage_acc is intentionally not persisted
  (per-process token accounting starts fresh on a re-invocation).
  """
  if not session.output_dir:
    return
  data = {
      "mode": session.mode,
      "topic": session.topic,
      "model": session.model,
      "output_dir": session.output_dir,
      "traj_meta": session.traj_meta,
      "refinements": session.refinements,
      "enum_context": session.enum_context,
      "writer_params": session.writer_params,
      "entries": [dataclasses.asdict(e) for e in session.entries.values()],
  }
  os.makedirs(session.output_dir, exist_ok=True)
  with open(session_path(session.output_dir), "w") as f:
    json.dump(data, f, indent=2, default=str)


def load_session(
    output_dir: str, model_override: str | None = None
) -> EnrichmentSession | None:
  """Rehydrate a saved session, or None if there isn't one."""
  path = session_path(output_dir)
  if not os.path.exists(path):
    return None
  with open(path) as f:
    data = json.load(f)
  entries = {}
  for ed in data.get("entries", []):
    es = EntryState(**ed)
    entries[es.entry_id] = es
  return EnrichmentSession(
      mode=data.get("mode", ""),
      topic=data.get("topic", ""),
      model=model_override or data.get("model", ""),
      output_dir=data.get("output_dir", output_dir),
      entries=entries,
      usage_acc={"input": 0, "output": 0},
      traj_meta=data.get("traj_meta", {}),
      refinements=data.get("refinements", []),
      enum_context=data.get("enum_context", ""),
      writer_params=data.get("writer_params", {}),
  )


def _entry_snippet(body: str, limit: int = 500) -> str:
  body = (body or "").strip()
  return body[:limit] + ("…" if len(body) > limit else "")


def _dispatch_context(session: EnrichmentSession) -> str:
  """Render the entry list + overview snippets for the dispatcher."""
  lines = []
  for e in session.entries.values():
    lines.append(
        f"- id: {e.entry_id} | display_name: {e.display_name} | category:"
        f" {e.category_id}"
    )
    lines.append(f"  overview_snippet: {_entry_snippet(e.overview_body, 400)}")
  return "\n".join(lines)


async def plan_refinement(
    user_text: str, session: EnrichmentSession, model: str
) -> RefinementPlan:
  """One schema-validated dispatcher call → a RefinementPlan."""
  prompt = (
      f"USER MESSAGE:\n{user_text}\n\n"
      f"CURRENT ENTRIES ({len(session.entries)}):\n"
      f"{_dispatch_context(session)}\n\n"
      "Decide the operation and produce the plan per the schema."
  )
  runner = create_refinement_dispatch_runner(model)
  return await common.run_schema_agent(
      runner, prompt, RefinementPlan, session.usage_acc
  )


async def _rewrite_entry(entry: EntryState, instruction: str, usage_acc: dict):
  """Re-generate one entry's overview applying `instruction`, reusing context."""
  history_block = ""
  if entry.refinement_history:
    history_block = (
        "\nREFINEMENT HISTORY (earlier changes already applied — honor"
        " them):\n"
        + "\n".join(f"  - {h}" for h in entry.refinement_history)
        + "\n"
    )
  refine_prompt = (
      "=== ORIGINAL GROUNDING CONTEXT (same sources as the first draft) ==="
      f"\n{entry.grounding_prompt}\n\n"
      "=== CURRENT OVERVIEW ===\n"
      f"```markdown\n{entry.overview_body}\n```\n"
      f"{history_block}\n"
      f"=== USER REFINEMENT REQUEST (this turn) ===\n{instruction}\n\n"
      "Produce the revised overview Markdown body now."
  )
  new_body = await common.generate_text_direct(
      REFINEMENT_WRITER_INSTRUCTION,
      refine_prompt,
      entry.writer_model,
      usage_acc,
  )
  new_body = common.clean_overview_body(new_body)
  written = entry.write(new_body)
  entry.overview_body = new_body
  entry.refinement_history.append(instruction)
  return written


async def apply_refinement(plan: RefinementPlan, session: EnrichmentSession):
  """Execute a RefinementPlan against the session."""
  if plan.operation == "answer":
    print(f"\n{plan.answer}\n", flush=True)
    return
  if plan.operation == "noop":
    msg = plan.answer or (
        "Could not interpret that — please rephrase, e.g. 'make the X"
        " overview more concise'."
    )
    print(f"\n[refine] {msg}\n", flush=True)
    return

  if plan.operation == "reenumerate":
    await _reenumerate(plan, session)
    return

  # rewrite
  if plan.target_entry_ids:
    targets = [
        session.entries[i] for i in plan.target_entry_ids if i in session.entries
    ]
    unknown = [i for i in plan.target_entry_ids if i not in session.entries]
    if unknown:
      print(f"[refine] ⚠️  Unknown entry id(s) ignored: {unknown}", flush=True)
  else:
    targets = list(session.entries.values())  # empty list = ALL entries

  if not targets:
    print("[refine] No matching entries to rewrite.", flush=True)
    return

  print(
      f"[refine] ✍️  Rewriting {len(targets)} entr"
      f"{'y' if len(targets) == 1 else 'ies'}: {plan.instruction}",
      flush=True,
  )
  results = await asyncio.gather(
      *[_rewrite_entry(e, plan.instruction, session.usage_acc) for e in targets]
  )
  for entry, written in zip(targets, results):
    print(f"[refine] ✅ {entry.entry_id}: {', '.join(written)}", flush=True)

  session.refinements.append({
      "operation": "rewrite",
      "instruction": plan.instruction,
      "entries": [e.entry_id for e in targets],
  })
  _persist(session)
  # Persist the updated session so the next refine turn (esp. a fresh webapp
  # re-invocation) sees the compounded bodies + history.
  save_session(session)


async def _reenumerate(plan: RefinementPlan, session: EnrichmentSession):
  """Re-run enumeration over the loaded context and materialize the delta.

  Re-enters the pipeline at Phase 2 (enumeration): re-seeds with the current
  entries (minus any the user removed), steers the EnumerationAgent with the
  user's guidance, then hands the new entry list to the mode-specific
  apply_reenumeration to add/remove/recategorize files on disk. No source doc is
  re-read — enumeration runs against session.enum_context (the original compiled
  context captured at the end of the initial run).
  """
  if not session.enum_context:
    print(
        "[refine] ⚠️  This session predates entry-set refinement (no saved"
        " enumeration context) — re-run the enrichment to enable add/remove/"
        "recategorize.",
        flush=True,
    )
    return

  remove = set(plan.remove_entry_ids or [])
  seeds = [
      {"id": e.entry_id, "display_name": e.display_name, "kind": e.kind}
      for e in session.entries.values()
      if e.entry_id not in remove
  ]
  print(
      f"[refine] 🧭 Re-enumerating ({len(seeds)} kept seed(s)"
      f"{', removing ' + ', '.join(sorted(remove)) if remove else ''})"
      f"{': ' + plan.enumeration_guidance if plan.enumeration_guidance else ''}",
      flush=True,
  )
  new_enum = await common.run_enumeration(
      session.topic,
      session.enum_context,
      seed_entries=seeds or None,
      model=session.model,
      usage_acc=session.usage_acc,
      extra_guidance=plan.enumeration_guidance,
      drop_ids=remove,
  )

  # Delegate file-level materialization to the mode (it owns the on-disk layout).
  from modes import context_overlay_mode, doc_mode, table_mode

  handler = {
      "doc": doc_mode,
      "table": table_mode,
      "context_overlay": context_overlay_mode,
  }.get(session.mode)
  if handler is None:
    print(f"[refine] ⚠️  Unknown mode '{session.mode}' — cannot re-enumerate.")
    return
  await handler.apply_reenumeration(session, new_enum, remove)

  session.refinements.append({
      "operation": "reenumerate",
      "instruction": plan.enumeration_guidance,
      "removed": sorted(remove),
      "entries": sorted(session.entries),
  })
  _persist(session)
  save_session(session)
  print(
      f"[refine] ✅ Re-enumeration complete — {len(session.entries)} entr"
      f"{'y' if len(session.entries) == 1 else 'ies'} now.",
      flush=True,
  )


def _persist(session: EnrichmentSession):
  """Re-write trajectory.json with the latest overviews + refinement log."""
  if not session.output_dir or not session.traj_meta:
    return
  m = session.traj_meta
  final_text = "\n\n".join(
      e.overview_body for e in session.entries.values() if e.overview_body
  )
  tool_uses = list(m.get("tool_uses", []))
  tool_responses = list(m.get("tool_responses", []))
  for r in session.refinements:
    tool_uses.append({"name": "refine", "args": {"instruction": r["instruction"]}})
    tool_responses.append({"name": "refine", "response": r})
  common.write_trajectory(
      session.output_dir,
      m.get("agent_type", session.mode),
      m.get("user_input", f"TOPIC: {session.topic}"),
      tool_uses,
      tool_responses,
      final_text,
      session.usage_acc,
  )


_BANNER = """
============================================================
Refinement mode — the docs and context are still loaded.
Type how you'd like to refine the output, e.g.
  · make the <name> overview more concise
  · add a "Data freshness" section to every entry
  · add a topic about <X> / remove the <name> entry  (re-enumerate)
  · regroup the entries by <theme>                    (re-categorize)
  · why is <name> in that category?
Commands: :entries (list)  :show <id> (print overview)  :quit
============================================================"""


def _print_summary(session: EnrichmentSession):
  print(_BANNER, flush=True)
  print(f"Mode: {session.mode}  |  Output: {session.output_dir}", flush=True)
  print(f"{len(session.entries)} entr"
        f"{'y' if len(session.entries) == 1 else 'ies'}:", flush=True)
  for e in session.entries.values():
    print(f"  · {e.entry_id}  ({e.category_id})", flush=True)


async def run_repl(session: EnrichmentSession, model: str):
  """Interactive refinement loop. No-op on a non-tty or empty session."""
  if not session or not session.entries:
    return
  if not sys.stdin.isatty():
    print(
        "[refine] stdin is not a TTY — skipping interactive refinement.",
        flush=True,
    )
    return

  _print_summary(session)
  while True:
    try:
      text = input("\nrefine> ").strip()
    except (EOFError, KeyboardInterrupt):
      print("\n[refine] Exiting.", flush=True)
      return
    if not text:
      continue
    low = text.lower()
    if low in (":quit", ":q", ":exit", "quit", "exit"):
      print("[refine] Exiting.", flush=True)
      return
    if low == ":entries":
      for e in session.entries.values():
        print(f"  · {e.entry_id}  ({e.category_id})  — {e.display_name}")
      continue
    if low.startswith(":show"):
      parts = text.split(maxsplit=1)
      if len(parts) == 2 and parts[1] in session.entries:
        print(f"\n{session.entries[parts[1]].overview_body}\n")
      else:
        print("[refine] usage: :show <entry_id>")
      continue
    try:
      plan = await plan_refinement(text, session, model)
      await apply_refinement(plan, session)
    except Exception as ex:  # pylint: disable=broad-except
      print(f"[refine] ⚠️  Refinement failed: {ex}", flush=True)


async def run_one_refinement(output_dir: str, instruction: str, model: str):
  """Apply a SINGLE refinement turn against a saved session, then exit.

  This is the webapp's non-interactive entrypoint (agent_runner
  --refine_instruction): rehydrate the session persisted by the initial run,
  dispatch + apply the one instruction, and persist the result. Streams the same
  `[refine] …` progress lines the REPL prints, which the webapp tails.
  """
  session = load_session(output_dir, model_override=model)
  if session is None:
    print(
        f"[refine] ❌ No saved session at {session_path(output_dir)} — run an"
        " enrichment first.",
        flush=True,
    )
    return
  if not session.entries:
    print("[refine] ❌ Saved session has no entries to refine.", flush=True)
    return
  print(
      f"[refine] 🔁 Refining {len(session.entries)} entr"
      f"{'y' if len(session.entries) == 1 else 'ies'} in {output_dir}",
      flush=True,
  )
  plan = await plan_refinement(instruction, session, model)
  await apply_refinement(plan, session)
  print("[refine] ✅ Done.", flush=True)
