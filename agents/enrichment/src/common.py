"""Helpers shared by the doc and table enrichment modes."""

import asyncio
import json
import os
import random
import re
import threading
import uuid

from engine import EnumerationResult, create_enumeration_runner
from google.genai import Client, types

# Transient Vertex/model-serving errors that are safe to retry. These otherwise
# abort a whole run: one call's exception propagates out of asyncio.gather and
# cancels the concurrent siblings. Matched case-insensitively on the error text
# (the SDK surfaces these as ClientError/ServerError/ApiError with the status in
# the message, so substring matching is more robust than exception types).
_RETRYABLE_MARKERS = (
    "429", "resource_exhausted", "rate limit", "quota exceeded",
    "503", "unavailable", "500", "internal error",
    "decode_preempted", "preempted", "unable_to_retry",
    "deadline", "timed out", "timeout", "connection reset",
)


def _is_retryable(exc: Exception) -> bool:
  msg = str(exc).lower()
  return any(m in msg for m in _RETRYABLE_MARKERS)


async def _with_retry(fn, *, what="LLM call", attempts=6,
                      base_delay=2.0, max_delay=60.0):
  """Run async `fn()` with exponential backoff on transient model errors.

  Retries 429 RESOURCE_EXHAUSTED / 503 / 500 / DECODE_PREEMPTED / timeouts a few
  times (exp backoff + jitter) so a single transient Vertex blip doesn't abort
  the whole enrichment run. Non-retryable errors raise immediately; if all
  attempts are exhausted the last error propagates.
  """
  for i in range(attempts):
    try:
      return await fn()
    except Exception as e:  # pylint: disable=broad-except
      if i == attempts - 1 or not _is_retryable(e):
        raise
      delay = min(max_delay, base_delay * (2 ** i)) + random.uniform(0, 1.5)
      print(
          f"[retry] {what}: {type(e).__name__}: {str(e)[:140]} — "
          f"attempt {i + 1}/{attempts}, backing off {delay:.1f}s",
          flush=True,
      )
      await asyncio.sleep(delay)

# v2.5 #4 + v2.6 #5: bypass ADK's LlmAgent/InMemoryRunner.
# Per-thread client cache — the genai SDK's pyOpenSSL transport mutates an SSL
# context per request, which is not thread-safe; sharing one client across many
# `asyncio.to_thread` workers fails with "Context has already been used to
# create a Connection, it cannot be mutated again". Thread-local clients (same
# pattern as drive_tools.get_service) avoid the race.
_DIRECT_CLIENT_TL = threading.local()


def _direct_genai_client() -> Client:
  """Per-thread Vertex genai client for direct-API generation calls."""
  client = getattr(_DIRECT_CLIENT_TL, "client", None)
  if client is None:
    from google.auth import default

    creds, _ = default()
    client = Client(
        vertexai=True,
        credentials=creds,
        project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
        location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
    )
    _DIRECT_CLIENT_TL.client = client
  return client


async def generate_text_direct(
    system_instruction: str, user_prompt: str, model: str, usage_acc: dict
) -> str:
  """Direct generate_content call bypassing ADK.

  Used wherever we want Flash long-context (or just want to skip LlmAgent
  overhead) — the writer (v2.5) and the summarizer (v2.6) both call this.

  Builds a fresh client per call. The genai SDK's pyOpenSSL transport mutates
  an SSL context per request, and any shared client (even thread-local) trips
  `Context has already been used to create a Connection, it cannot be mutated
  again` once a worker thread is reused for a second call. Per-call clients
  are cheap relative to the LLM call latency itself.
  """

  def _call():
    from google.auth import default

    creds, _ = default()
    client = Client(
        vertexai=True,
        credentials=creds,
        project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
        location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
    )
    config = types.GenerateContentConfig(system_instruction=system_instruction)
    return client.models.generate_content(
        model=model, contents=user_prompt, config=config
    )

  async def _once():
    response = await asyncio.to_thread(_call)
    usage = getattr(response, "usage_metadata", None)
    if usage is not None and usage_acc is not None:
      usage_acc["input"] += getattr(usage, "prompt_token_count", 0) or 0
      usage_acc["output"] += getattr(usage, "candidates_token_count", 0) or 0
    return response.text or ""

  return await _with_retry(_once, what=f"generate_content({model})")


# Back-compat alias for the v2.5 writer callers (semantically the same function).
write_entry_direct = generate_text_direct


async def run_enumeration(
    topic: str,
    compiled_context: str,
    seed_entries: list[dict] | None,
    model: str,
    usage_acc: dict,
    extra_guidance: str = "",
    drop_ids: set[str] | None = None,
    scoping_guidance: str = "",
) -> EnumerationResult:
  """Shared EnumerationAgent invocation.

  Returns the structured EnumerationResult.

  seed_entries (table mode): list of {id, display_name, kind} dicts. Each must
    appear in the output with the exact id. Pass None for doc mode (the agent
    enumerates entries freely from the context).
  compiled_context: free-form text (doc mode: compiled batch summaries;
    table mode: per-table routing descriptors).
  extra_guidance: optional free-text steer for a re-enumeration refinement turn
    (e.g. "add a topic about X", "split Y into A and B"). Empty for the initial
    run, so the default behavior is unchanged.
  drop_ids: optional ids the user removed; rendered as an explicit "do NOT
    include these" directive so a re-enumeration honors removals even though the
    source context still mentions them.
  """
  runner = create_enumeration_runner(model)

  seed_block = ""
  if seed_entries:
    seed_block = (
        "PRE-EXISTING SEED ENTRIES (these MUST appear in your output with the"
        " EXACT id given, and with `kind` set to the value shown):\n"
        + "\n".join(
            f"- id: {e['id']}, display_name: {e.get('display_name', e['id'])}, "
            f"kind: {e.get('kind', 'kb')}"
            for e in seed_entries
        )
        + "\n\n"
    )
  guidance_block = ""
  if extra_guidance:
    guidance_block += (
        "USER REFINEMENT GUIDANCE (apply this to the entry set — it OVERRIDES"
        " the default enumeration; keep all OTHER existing entries and their"
        " categories stable unless this guidance requires"
        f" otherwise):\n{extra_guidance}\n\n"
    )
  if drop_ids:
    guidance_block += (
        "DO NOT include these entry ids — the user explicitly removed"
        f" them: {', '.join(sorted(drop_ids))}\n\n"
    )
  if scoping_guidance:
    # HYBRID scoping: per-table overlays already own all table-specific knowledge,
    # so the KB enumeration must be restricted to the cross-cutting complement.
    # This OVERRIDES the default "enumerate every concept in the context" behavior;
    # returning an EMPTY entry set is valid and expected when the source is wholly
    # table-specific.
    guidance_block += (
        "SCOPING CONSTRAINT — this OVERRIDES the default behavior of enumerating"
        " every concept found in the context. Returning an EMPTY set (no"
        " categories, no entries) is a VALID and expected answer when nothing"
        f" qualifies:\n{scoping_guidance}\n\n"
    )
  prompt = (
      f"TOPIC: {topic}\n\n{seed_block}{guidance_block}"
      f"COMPILED CONTEXT:\n{compiled_context}\n\n"
      "Produce the canonical categorized entry list per the schema."
  )
  async def _once():
    user_id = str(uuid.uuid4())
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user_id
    )
    raw_text = ""
    local_in = local_out = 0
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session.id,
        new_message=types.Content(
            role="user", parts=[types.Part.from_text(text=prompt)]
        ),
    ):
      usage = getattr(event, "usage_metadata", None)
      if usage:
        local_in += getattr(usage, "prompt_token_count", 0) or 0
        local_out += getattr(usage, "candidates_token_count", 0) or 0
      if event.content and event.content.parts:
        for part in event.content.parts:
          if part.text:
            raw_text += part.text
    if usage_acc is not None:
      usage_acc["input"] += local_in
      usage_acc["output"] += local_out
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
      m = re.match(r"^```(?:json)?\s*\n(.*)\n```$", cleaned, re.S)
      if m:
        cleaned = m.group(1).strip()
    return EnumerationResult.model_validate_json(cleaned)

  return await _with_retry(_once, what="enumeration")


async def run_schema_agent(runner, prompt: str, model_cls, usage_acc: dict):
  """Run a schema-constrained ADK runner once and parse its JSON output.

  Generalizes the run_async + ```-fence-strip + model_validate_json dance used
  by run_enumeration, for any LlmAgent created with an `output_schema`. Returns
  an instance of `model_cls` (a pydantic BaseModel subclass).
  """
  async def _once():
    user_id = str(uuid.uuid4())
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user_id
    )
    raw_text = ""
    local_in = local_out = 0
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session.id,
        new_message=types.Content(
            role="user", parts=[types.Part.from_text(text=prompt)]
        ),
    ):
      usage = getattr(event, "usage_metadata", None)
      if usage:
        local_in += getattr(usage, "prompt_token_count", 0) or 0
        local_out += getattr(usage, "candidates_token_count", 0) or 0
      if event.content and event.content.parts:
        for part in event.content.parts:
          if part.text:
            raw_text += part.text
    if usage_acc is not None:
      usage_acc["input"] += local_in
      usage_acc["output"] += local_out
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
      m = re.match(r"^```(?:json)?\s*\n(.*)\n```$", cleaned, re.S)
      if m:
        cleaned = m.group(1).strip()
    return model_cls.model_validate_json(cleaned)

  return await _with_retry(_once, what="schema_agent")


async def run_text(runner, prompt: str, usage_acc: dict | None = None) -> str:
  """Runs an InMemoryRunner once and returns the concatenated text output.

  Accumulates token usage into usage_acc when provided.
  """
  async def _once():
    user_id = str(uuid.uuid4())
    session = await runner.session_service.create_session(
        app_name=runner.app_name, user_id=user_id
    )
    out = ""
    local_in = local_out = 0
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session.id,
        new_message=types.Content(
            role="user", parts=[types.Part.from_text(text=prompt)]
        ),
    ):
      usage = getattr(event, "usage_metadata", None)
      if usage:
        local_in += getattr(usage, "prompt_token_count", 0) or 0
        local_out += getattr(usage, "candidates_token_count", 0) or 0
      if event.content and event.content.parts:
        for part in event.content.parts:
          if part.text:
            out += part.text
    # Only fold usage in on success so a retried attempt isn't double-counted.
    if usage_acc is not None:
      usage_acc["input"] += local_in
      usage_acc["output"] += local_out
    return out

  return await _with_retry(_once, what="adk_generate")


async def run_structured(
    runner, prompt: str, schema_class, usage_acc: dict | None = None
):
  """Runs an InMemoryRunner once and returns a validated structured result."""
  raw_text = await run_text(runner, prompt, usage_acc)
  cleaned = raw_text.strip()
  if cleaned.startswith("```"):
    m = re.match(r"^```(?:json)?\s*\n(.*)\n```$", cleaned, re.S)
    if m:
      cleaned = m.group(1).strip()
  try:
    return schema_class.model_validate_json(cleaned)
  except Exception as e:
    print(f"[!] Error parsing structured output: {e}\nRaw output: {raw_text}")
    return None


def _delink_local_sources(text: str) -> str:
  """Render local-file source citations as plain text instead of links.

  The writer cites sources as `[Title](URL)`. For a local markdown input the
  "URL" is a filesystem path (e.g. `/tmp/corpus/orders.md`), which is a broken
  link when the overview is viewed in a browser and meaningless once the entry
  is published to the catalog. Keep the title text but drop the local target;
  real web links (http/https/mailto, incl. Google Docs/Drive) are left intact.
  """
  def _repl(m):
    label, target = m.group(1), m.group(2).strip()
    low = target.lower()
    if low.startswith(("http://", "https://", "mailto:")):
      return m.group(0)  # keep real web links
    if target.startswith(("/", "./", "../", "~")) or low.endswith(
        (".md", ".markdown")
    ):
      return label  # local path: keep the text, drop the broken link
    return m.group(0)

  return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _repl, text)


def clean_overview_body(text: str) -> str:
  """Strip stray code fences / YAML frontmatter the model may have added, so the

  sidecar body is pure Markdown (table mode).
  """
  t = (text or "").strip()
  # Strip an outer ```...``` fence ONLY if the model wrongly wrapped the whole
  # body in one. Greedy so inner ```sql blocks (Sample SQL) are preserved.
  if t.startswith("```"):
    m = re.match(r"^```[a-zA-Z]*\s*\n(.*)\n```$", t, re.S)
    if m:
      t = m.group(1).strip()
  # Strip a leading YAML frontmatter block if present (we add our own). The
  # middle is optional so an EMPTY block (`---\n---`) is stripped too.
  if t.startswith("---"):
    m = re.match(r"^---\s*\n(?:.*?\n)?---\s*\n(.*)$", t, re.S)
    if m:
      t = m.group(1).strip()
  # Local-file source citations -> plain text (broken/meaningless as links).
  t = _delink_local_sources(t)
  return t


def maybe_convert_to_okf(output_dir: str | None, output_format: str) -> None:
  """If `output_format == 'okf'`, convert the finished `catalog/` tree into an

  OKF `bundle/` (publishable via `kcmd push --format okf`).

  A no-op for the default 'kcmd' format. Called at the end of each mode's run so
  every mode emits OKF identically without touching its per-entry write sites.
  """
  if output_format != "okf" or not output_dir:
    return
  import okf_serializer

  bundle = okf_serializer.convert_tree(output_dir)
  if bundle:
    print(f"[OKF] ✅ Converted catalog/ -> OKF bundle at {bundle}", flush=True)


def parse_mdcode_blocks(text: str, output_dir: str) -> list[str]:
  """Parse fenced code blocks preceded by a backticked relative path and write

  them under output_dir. Used by doc mode where the LLM emits the mdcode files.
  """
  written = []
  if not output_dir:
    return written
  blocks = re.split(r"```(yaml|markdown|json|md)", text)
  for i in range(1, len(blocks), 2):
    block_content = blocks[i + 1].split("```")[0].strip()
    preceding_text = blocks[i - 1].strip().split("\n")[-1].strip()
    filename = None
    if preceding_text.startswith("`") and preceding_text.endswith("`"):
      filename = (
          preceding_text.replace("`", "")
          .replace("'", "")
          .replace('"', "")
          .strip()
      )
    if not filename:
      continue
    full_path = os.path.join(output_dir, filename)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w") as f:
      f.write(block_content + "\n")
    written.append(filename)
    print(f"[+] Saved {filename} to {full_path}")
  return written


def doc_tool_calls(docs: list) -> tuple[list, list]:
  """Build per-document trajectory tool calls from a prepared-docs list.

  Gives table/context_overlay modes the same per-source tool-call recording doc
  mode already has, so eval counts tool calls consistently and grounds
  hallucination checks on clean per-doc `content` (not a truncated json blob of
  the routing response). Each doc dict carries a `_kind` set by the mode's
  prepare step: `local_md` -> read_local_md, `code` -> explore_repo, anything
  else -> fetch_gdoc. Returns (tool_uses, tool_responses).
  """
  uses, responses = [], []
  for d in (docs or []):
    kind = d.get("_kind", "gdoc")
    url = d.get("url", "")
    content = (d.get("content") or "")[:50000]
    if kind == "code":
      uses.append({"name": "explore_repo", "args": {"component": d.get("name", "")}})
      responses.append(
          {"name": "explore_repo", "response": {"url": url, "content": content}})
    else:
      tn = "read_local_md" if kind == "local_md" else "fetch_gdoc"
      uses.append({"name": tn, "args": {"url": url}})
      responses.append(
          {"name": tn,
           "response": {"url": url, "name": d.get("name", ""), "content": content}})
  return uses, responses


def write_trajectory(
    output_dir: str,
    agent_type: str,
    user_input: str,
    tool_uses: list,
    tool_responses: list,
    final_text: str,
    usage_acc: dict,
) -> None:
  """Persist trajectory.json capturing the agent's run (same shape for both modes).

  Written next to the generated mdcode as a record of what the agent read and
  produced; consumed by external evaluation/tooling that reads it by path.
  """
  if not output_dir:
    return
  os.makedirs(output_dir, exist_ok=True)
  trajectory = {
      "agent_type": agent_type,
      "user_input": user_input,
      "tool_uses": tool_uses,
      "tool_responses": tool_responses,
      "final_text": final_text,
      "token_usage": {
          "input": usage_acc["input"],
          "output": usage_acc["output"],
      },
  }
  traj_path = os.path.join(output_dir, "trajectory.json")
  with open(traj_path, "w") as f:
    json.dump(trajectory, f, indent=2, default=str)
  print(f"\n[+] Saved trajectory to {traj_path}")
