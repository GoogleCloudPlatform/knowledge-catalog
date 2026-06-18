"""LLM agents for the unified enrichment agent (doc + table modes).

Shared (used by both modes):
  * EnumerationAgent     — produces a canonical categorized entry list from
                           context. Output is a strict Pydantic-schema JSON
                           ({categories: [{id, title, entries: [...]}]}) so the
                           entry ids and dedup decisions are stable across runs.
                           Used in doc mode to derive entries from a compiled
                           summary, and in table mode to categorize the entries
                           kcmd already pulled.
  * EntryWriterAgent     — writes ONE entry's overview body. Fanned out per
                           entry by both modes; small inputs keep us on Flash.

Doc mode (legacy MdcodeAgent retained for backward compat / fallback):
  * SummarizerAgent      — map-reduce summarizer over crawled Google Docs.
  * MdcodeAgent          — emits the knowledge-base mdcode from the compiled
                           summary (legacy; superseded by EnumerationAgent +
                           per-entry EntryWriterAgent fan-out).

Table mode:
  * DocSummarizerAgent   — distills ONE Drive doc into a compact router
  descriptor.
  * RelevanceRouterAgent — picks which docs are relevant to a given table.
  * TableOverviewAgent   — (legacy) writes one table's enriched overview from
                           its relevant docs. Superseded by EntryWriterAgent.

Nothing here is project-specific: the model is supplied by the caller (the
`--model` CLI flag) and the Vertex project/location come from the environment
(`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`, set by the CLI from
`--project` / `--location`).
"""

import os
import typing as t

from google.adk.agents import llm_agent
from google.adk.models import Gemini
from google.adk.runners import InMemoryRunner
from google.genai import Client
from pydantic import BaseModel, Field


class VertexGemini(Gemini):
  """Gemini on Vertex AI via Application Default Credentials.

  Project/location are read from the environment so the tool works in any
  customer project.
  """

  _cached_client = None

  @property
  def api_client(self) -> Client:
    if self._cached_client is None:
      from google.auth import default

      creds, _ = default()
      self._cached_client = Client(
          vertexai=True,
          credentials=creds,
          project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
          location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
      )
    return self._cached_client


# Pinned for structured-extraction steps with SMALL inputs (per-doc descriptors,
# JSON routing). Flash is ~3-4x faster. The caller's --model is used for: (a)
# the heavy write steps where quality matters, and (b) the doc-mode batch
# summarizer — see comment on create_summarizer_runner below.
_LIGHT_MODEL = os.environ.get("KC_LIGHT_MODEL", "gemini-2.5-flash")

# Per-doc summarizer model. Each call is ONE doc in (≤60K chars), one neutral
# card out (~2K chars) — small enough to stay well under Flash's per-call
# context limits regardless of routing, and lighter on latency / cost than
# Pro. Result is cached at ~/.kc_enrich_cache/summaries/ keyed on
# (doc_id, modifiedTime), so any drift introduced by using a smaller model
# only shows up on the FIRST run against a doc.
PER_DOC_SUMMARIZER_MODEL = _LIGHT_MODEL


# ============================ Doc mode ============================

# Public so callers can pass it to common.generate_text_direct (v2.6 #5: direct
# API for the summarizer to use Flash long-context without ADK's 32K routing trap).
SUMMARIZER_INSTRUCTION = """You are an expert technical summarizer for a Metadata as Code generation pipeline.
Given a topic, a MASTER SCOPE document, and a batch of raw Google Documents:
1. Understand the overarching projects and goals from the MASTER SCOPE.
2. For each document in the batch, extract all relevant architectural requirements, proposals, and details.
3. STRUCTURED EXTRACTION: You MUST map every finding to one of the overarching projects defined in the MASTER SCOPE. Do not create orphaned topics.
4. SOURCE TRACKING: You MUST append an explicit "Source References" section to every single finding or sub-topic you extract. Instead of using raw URLs, you MUST format the sources as Markdown links using the Document's Title (inferred from the document content) as the link text (e.g., `[Document Title](URL)`). Do not drop URLs.
5. Do not output final mdcode formats; output a structured, dense markdown summary grouping findings by the Master Scope projects."""


def create_summarizer_runner(model: str) -> InMemoryRunner:
  """Legacy ADK-runner factory for SummarizerAgent. Kept for back-compat.

  The current doc-mode pipeline calls common.generate_text_direct directly
  with SUMMARIZER_INSTRUCTION (v2.6 #5) — bypassing ADK lets us use Flash on
  big-input batches without hitting the 32K ADK Flash routing cap.
  """
  agent = llm_agent.LlmAgent(
      name="SummarizerAgent",
      description="Summarizes Google Drive documents.",
      model=VertexGemini(model=model),
      instruction=SUMMARIZER_INSTRUCTION,
  )
  return InMemoryRunner(agent=agent)


# Topic-agnostic per-doc summarizer. The output is CACHED at
# ~/.kc_enrich_cache/summaries/<doc_id>.summary and reused across runs
# regardless of what `topic` the run is enriching for, so the prompt MUST
# NOT bake any topic-specific framing into the output. Downstream the
# topic-shaped reduction step (see doc_mode._reduce_summaries_with_topic)
# is responsible for filtering / re-grouping these neutral cards through
# the topic lens.
PER_DOC_SUMMARIZER_INSTRUCTION = """You are summarizing ONE Google Drive document into a reusable, topic-NEUTRAL "doc card" that will be cached and reused for many different downstream analyses with different focus topics.

NEUTRAL means: do not filter by any topic, do not editorialize, do not collapse multiple claims into a generic overview. Capture enough that any analyst could understand what the document is about, what it discusses, and what claims it makes, without re-reading it.

Output EXACTLY this Markdown shape and nothing else:

# {document title — as it appears in the doc, or a 6-word descriptor if untitled}

**Source:** [{document title}]({source url})

## Identity
- **Type:** {design doc / runbook / README / launch plan / chat log / wiki page / etc.}
- **Purpose (1 sentence):** {what the document is for, neutrally stated}
- **Status (if stated):** {draft / proposal / approved / archived — only if the doc says so explicitly}

## Topics and Entities
Comma-separated list of EVERY distinct named project, system, agent, framework, product, service, team, repository, dataset, table, column, metric, business concept, or person that the document explicitly names. Be exhaustive. Preserve the exact spellings the document uses. Do not invent or paraphrase entity names.

## Key Claims and Facts
Bullet list of every substantive claim, decision, requirement, design choice, fact, metric value, data point, schedule, or constraint asserted in the document. One claim per bullet. Include numbers / specifics / pre-decided tradeoffs verbatim where possible. Do not editorialize.

## References Cited
Bullet list of every external link, document reference, code path (e.g. `src/path/to/file.py`), table FQN, or system URL the document points to. One per bullet. If the document cites no external references, write "(none)".

## Open Questions / TODOs (if any)
Bullet list of questions or TODOs the document leaves unresolved. Skip this section if the document raises none.

Rules:
- Be faithful. Quote specifics rather than paraphrasing when in doubt.
- Be neutral. Do NOT decide what's important or relevant — the downstream stage does that with the topic.
- Do not output a closing summary, conclusion, or recommendation."""


def create_per_doc_summarizer_runner(model: str) -> InMemoryRunner:
  """Topic-agnostic per-doc summarizer factory.

  Used by the cached per-doc Map stage in doc_mode.
  """
  agent = llm_agent.LlmAgent(
      name="PerDocSummarizerAgent",
      description=(
          "Summarizes a single document into a reusable, topic-neutral doc"
          " card. Output is cached across runs."
      ),
      model=VertexGemini(model=model),
      instruction=PER_DOC_SUMMARIZER_INSTRUCTION,
  )
  return InMemoryRunner(agent=agent)


DOC_QUERY_EXTRACTOR_INSTRUCTION = """You extract SQL queries from documentation that reference a specific BigQuery table.

You will receive:
- TABLE: a fully-qualified `project.dataset.table` name.
- DOC SNIPPETS: one or more documentation excerpts that may or may not contain SQL queries referencing the table.

Find every distinct, runnable SQL query that:
- Explicitly references the target TABLE by name (e.g. backticked `project.dataset.table` or unqualified `table` when the surrounding context makes the dataset unambiguous), AND
- Is presented as an EXAMPLE the reader is meant to run/adapt (typically inside a ```sql code block or a fenced code block, occasionally inline if the doc is short and informal).

For EACH extracted query, output ONE line of compact JSON (no trailing commas, no surrounding array brackets, no commentary):

{"description": "<1-sentence summary of what the query does, in plain English>", "sql": "<the FULL SQL with newlines escaped as \\n>"}

Rules:
- Output ONLY JSON Lines (JSONL). No prose, no markdown fences, no headers.
- If you find zero queries, output nothing (an empty response).
- Preserve the query exactly as written — do NOT normalize literals, do NOT reformat whitespace beyond escaping newlines, do NOT strip comments.
- Skip queries that reference other tables but not the target TABLE.
- Skip SELECT * sanity checks and other trivial 1-liners unless they're the only example present.
"""


def create_doc_query_extractor_runner(model: str) -> InMemoryRunner:
  """Extractor agent for SQL examples found in routed documentation.

  Per-table call: given the docs that the router selected for ONE table,
  pull out any SQL queries that reference that table. Output is JSON
  Lines for trivial parsing. Used by table_mode.py to merge doc-derived
  queries into the per-table `queries` aspect alongside the
  INFORMATION_SCHEMA-derived ones.

  Args:
    model: Model name.

  Returns:
    An InMemoryRunner for the extractor agent.
  """
  del model  # unused
  agent = llm_agent.LlmAgent(
      name="DocQueryExtractorAgent",
      description=(
          "Extracts SQL examples for ONE table from its routed documentation."
      ),
      model=VertexGemini(model=_LIGHT_MODEL),
      instruction=DOC_QUERY_EXTRACTOR_INSTRUCTION,
  )
  return InMemoryRunner(agent=agent)


# Topic-shaped reducer. Consumes a batch of neutral per-doc cards (from
# the cached Map stage) and produces a topic-relevant grouped summary
# the enumerator can act on. The output of this stage is NOT cached —
# it depends on the user's topic, which is allowed to change run-to-run.
TOPIC_REDUCER_INSTRUCTION = """You are reducing a batch of neutral per-document summary cards through a TOPIC LENS for a Metadata as Code generation pipeline.

You will receive:
- TOPIC: the focus topic the user is enriching the knowledge base for
- MASTER SCOPE: an overarching scope document grouping the corpus into named projects (may be empty)
- BATCH CARDS: K neutral per-doc cards, each with Identity / Topics and Entities / Key Claims and Facts / References Cited sections

Your job:
1. Identify which Topics/Entities/Claims across the batch are relevant to the TOPIC and MASTER SCOPE.
2. STRUCTURED EXTRACTION: map every relevant finding to one of the overarching projects defined in the MASTER SCOPE. Do not create orphaned topics.
3. SOURCE TRACKING: every finding MUST carry the source link from the doc card it came from, formatted as a Markdown link using the Document Title (e.g., `[Document Title](URL)`). Do not drop URLs.
4. Skip cards that are not relevant to the TOPIC — do not pad the output with filler.
5. Output a structured, dense Markdown summary grouping findings by MASTER SCOPE project. Do NOT output final mdcode."""


def create_topic_reducer_runner(model: str) -> InMemoryRunner:
  """Topic-shaped reducer factory.

  Operates on per-doc summaries (not raw docs), so its input is much smaller
  than the legacy batch summarizer.
  """
  agent = llm_agent.LlmAgent(
      name="TopicReducerAgent",
      description=(
          "Reduces a batch of neutral per-doc summaries through a topic"
          " lens, producing a structured grouped summary."
      ),
      model=VertexGemini(model=model),
      instruction=TOPIC_REDUCER_INSTRUCTION,
  )
  return InMemoryRunner(agent=agent)


_MDCODE_INSTRUCTION = """You are an expert Document Knowledge Base Enrichment Agent for Google Cloud Dataplex.

Your workflow:
1. You will receive a compiled summary of multiple Google Docs regarding a specific topic.

2. ENUMERATE NAMED PROJECTS FIRST. Before drafting any entries, scan the compiled summary and produce a numbered list of every distinct named project, agent, system, framework, product, service, or work area that:
   (a) appears as its own heading or sub-heading in the compiled summary, OR
   (b) is referenced by a specific name in two or more of the batch summaries.
   Do NOT merge similar-sounding items at this step — list them separately and let later deduplication handle true synonyms. Output this list inline as the first thing in your response, wrapped in <enumeration>...</enumeration> tags so a downstream parser can audit it.

3. ONE-TO-ONE MAPPING. The entries you output MUST map 1:1 to the enumeration in step 2 — same count, same identities. If the enumeration has K items, you MUST output K entries. Do NOT fold a smaller/lesser-documented project into a larger one "because it's related" — generate its entry with whatever evidence the summary provides, even if the resulting overview is short. The only allowed deviation is collapsing TRUE SYNONYMS (e.g. "KC Discovery" and "knowledge-catalog-discovery-agent" referring to the same system); in that case, note the merge in a brief comment line above the affected entry's code block.

4. Map to Entries: Map each enumerated item to an individual Dataplex entry of type `__ENTRY_TYPE__`.

5. Create Aspects: For each entry, synthesize all relevant information and format it as Markdown sidecar files (Aspects) attached to the entry.

6. Output mdcode: Your final output must strictly follow the Metadata-as-Code (mdcode) YAML standard.
   - Do NOT output a `catalog.yaml` manifest — it is generated separately by the CLI. Output ONLY the entry files and their markdown sidecars.
   - The entry count from step 2's enumeration is binding. Dropping or merging entries beyond true synonyms is a failure. Ensure all collected source URLs are populated in the Overview sidecar under a 'Source References' section, strictly formatted as Markdown links using the Document Title (e.g., `* [Document Title](URL)`).
   - You MUST output all individual entry YAML files and markdown sidecar files within a `catalog/` directory to adhere to the Metadata-as-Code directory hierarchy (e.g., `` `catalog/[entry_id].yaml` ``). Do not wrap filenames in single quotes (`'`). The entry file MUST include `id`, `type` (`__ENTRY_TYPE__`), `resource` (as an object with `name`, `displayName`, and `description` to populate the UI properly). **CRITICAL: You MUST wrap all text values for `description` and `displayName` inside double quotes (`""`) to prevent YAML parser syntax errors caused by colons or special characters.**
   - Unstructured text content in aspects (like overviews containing your extracted requirements/links) MUST be represented as sidecar markdown files in the catalog directory (e.g., `` `catalog/[entry_id].overview.md` ``). The markdown file MUST have YAML frontmatter (between `---` lines) and the unstructured text below it.
   - Precede every code block with a backtick-wrapped relative filepath (e.g. `catalog/[entry_id].yaml`).

For example, an entry YAML should look like:
```yaml
id: my-project
type: __ENTRY_TYPE__
resource:
  name: __RESOURCE_NAME_PREFIX__/my-project
  displayName: "My Project Name"
  description: "A short 1-sentence summary of the project."
```"""


def create_mdcode_runner(
    model: str, entry_type: str, resource_name_prefix: str
) -> InMemoryRunner:
  instruction = _MDCODE_INSTRUCTION.replace(
      "__ENTRY_TYPE__", entry_type
  ).replace("__RESOURCE_NAME_PREFIX__", resource_name_prefix)
  agent = llm_agent.LlmAgent(
      name="MdcodeAgent",
      description="Generates Dataplex mdcode entries from summaries.",
      model=VertexGemini(model=model),
      instruction=instruction,
  )
  return InMemoryRunner(agent=agent)


# =========================== Table mode ===========================


def create_doc_summarizer_runner(model: str) -> InMemoryRunner:
  """Distills ONE folder document into a compact, router-friendly descriptor."""
  agent = llm_agent.LlmAgent(
      name="DocSummarizerAgent",
      description=(
          "Summarizes a single Drive document into a compact descriptor."
      ),
      model=VertexGemini(model=_LIGHT_MODEL),
      instruction="""You are summarizing ONE document so a router can decide which BigQuery tables it is relevant to, AND extracting any cross-table facts the document states.

Output EXACTLY this shape and nothing else:

Title: <the document's inferred title>
Summary: <2-4 sentences on what data/system/domain this document describes>
Key entities: <comma-separated tables, datasets, columns, metrics, systems, or business terms this document actually discusses>
<CONCEPTS>[ ...JSON array... ]</CONCEPTS>

For Title/Summary/Key entities: be concrete and faithful — list the specific entities/columns/metrics named in the document. Do not invent.

For the <CONCEPTS> block: extract every CROSS-TABLE fact this document EXPLICITLY states — facts that connect two or more tables, or that define a metric / grain / source-of-truth spanning tables. Each element:
  {"kind":"join|metric|relationship",
   "tables":[table names this fact involves — use the exact names from DATASET TABLES in the prompt when given, else the names as written in the doc],
   "title":"<short name>",
   "body":"<the fact in 1-3 sentences, in concise data-catalog documentation style; include the join keys / ON clause or the metric formula verbatim if the doc gives them>"}
Rules: ground ONLY in this document; do NOT invent joins, keys, or formulas; phrase the body in neutral catalog wording. If the document states no cross-table facts, output <CONCEPTS>[]</CONCEPTS>. Output nothing after the </CONCEPTS> tag.""",
  )
  return InMemoryRunner(agent=agent)


def create_router_runner(model: str) -> InMemoryRunner:
  """Decides which folder docs are relevant to a single table."""
  agent = llm_agent.LlmAgent(
      name="RelevanceRouterAgent",
      description="Scores folder-document relevance to one BigQuery table.",
      model=VertexGemini(model=_LIGHT_MODEL),
      instruction="""You are a precise relevance router. You are given ONE BigQuery table (its name and columns) and a numbered list of candidate documents (each with a title, summary, and key entities).

Decide which documents genuinely provide domain knowledge that would help DOCUMENT THIS SPECIFIC TABLE — e.g. they define this table, its columns/metrics, its source system, or the business process it records. A document that merely shares a broad theme but does not concern this table's data is NOT relevant.

Output ONLY a JSON array (no prose, no code fences). Each element: {"doc": <number>, "score": <0.0-1.0>, "reason": "<short reason>"}. Include an element ONLY for documents with score >= 0.3; if none qualify, output []. Be conservative — prefer precision over recall.""",
  )
  return InMemoryRunner(agent=agent)


def create_table_overview_runner(model: str) -> InMemoryRunner:
  """Writes the enriched OVERVIEW prose for one table (the caller assembles the

  mdcode files deterministically).
  """
  agent = llm_agent.LlmAgent(
      name="TableOverviewAgent",
      description=(
          "Writes the enriched overview for one BigQuery table from its"
          " relevant docs."
      ),
      model=VertexGemini(model=model),
      instruction="""You are a Knowledge Catalog Enrichment Agent for Google Cloud Dataplex.

You will receive:
  - RELEVANT CONTEXT DOCUMENTS (zero or more) that a router has already determined pertain to THIS table, each with its title and source URL, and
  - the metadata for ONE BigQuery table (its name and schema columns).

Your job: write a rich, accurate OVERVIEW for THIS table, grounded STRICTLY in the provided context documents, the schema, and the existing metadata.

GROUNDING RULES — do not make anything up:
   - Every statement must be supported by the provided context documents, the schema columns, or the existing metadata. Do NOT invent facts, owners, SLAs, pipelines, semantics, or values that are not present in the input.
   - If something is not covered by the inputs, leave it out — never guess or fill gaps with plausible-sounding content.

ALWAYS emphasize these two sections when the inputs support them (this is the default focus):
   1. `## Lineage` — describe upstream sources, the producing pipeline/job, transformations, and downstream consumers, but ONLY as documented in the provided context documents. Cite the source for each lineage claim. If the documents do not describe lineage, write a brief note that lineage is not documented in the provided sources (do not fabricate it).
   2. `## Sample SQL` — provide one or more example queries in fenced ```sql blocks. SQL MUST reference ONLY columns that exist in the provided schema, and the fully-qualified table name `project.dataset.table` derived from the table metadata. Any joins, filters, or derivations may ONLY reflect logic explicitly described in the provided documents; if no such logic is documented, keep the examples to simple, schema-grounded queries (e.g. column selection, basic aggregation over real columns) and do not invent business rules. If the schema is unavailable, omit this section.

Also cover, where the inputs support them: what the table contains, what it is used for, the meaning of key columns, and derivations/metrics. Additional relevant topics from the user's instruction may be included as further sections. End with a `## Source References` section listing the `[Title](URL)` links of the provided context documents that actually informed the overview.

If NO context documents are provided, write the overview from the table's schema and existing metadata ONLY (you may still include schema-grounded `## Sample SQL` and a "lineage not documented" note), and OMIT the `## Source References` section entirely (do not fabricate sources).

OUTPUT RULES (important):
   - Output ONLY the overview as Markdown body text. Start with a single top-level heading line (e.g. `# <Table> Overview`).
   - Do NOT output YAML, do NOT output frontmatter (no `---` lines), and do NOT print any file paths. (Fenced ```sql code blocks inside the body ARE allowed for the Sample SQL section.) Just the Markdown overview itself.""",
  )
  return InMemoryRunner(agent=agent)


# ============================ Shared: enumeration + writer ============================

# Pydantic models used as the EnumerationAgent's `output_schema`. Strict JSON
# output kills the surface-form drift we saw in the v3 prompt-only attempt
# (`brewmax` + `brewmax-framework` getting emitted as two entries, etc.) — the
# model has to pick ONE canonical id and list other forms as aliases.


class EnumeratedEntry(BaseModel):
  id: str = Field(
      description=(
          "kebab-case canonical identifier used as the filename stem. Stable"
          " across runs — pick the most fully-spelled form of the project's"
          " name."
      )
  )
  display_name: str = Field(description="Human-readable name (Title Case).")
  aliases: list[str] = Field(
      default_factory=list,
      description=(
          "All other surface forms (acronyms, alternate spellings, "
          "framework/agent suffix variants) for this same project that "
          "appeared in the input. The model MUST list them here rather "
          "than as separate entries."
      ),
  )
  description: str = Field(
      description="Single sentence summary of what this entry is."
  )
  primary_source_urls: list[str] = Field(
      default_factory=list,
      description=(
          "1-5 Google Doc URLs from the input that most directly describe this"
          " entry. Used by the downstream writer to scope its grounding."
      ),
  )
  kind: t.Literal["kb", "table"] = Field(
      description=(
          "'table' if this entry was a seeded BigQuery table (table mode); "
          "'kb' if the entry was discovered from documents (doc mode)."
      )
  )


class Category(BaseModel):
  id: str = Field(
      description="kebab-case category identifier used as a subdirectory name."
  )
  title: str = Field(description="Human-readable category title.")
  description: str = Field(
      description="Single sentence describing the theme of this category."
  )
  entries: list[EnumeratedEntry] = Field(
      description="Entries that belong to this category."
  )


class EnumerationResult(BaseModel):
  categories: list[Category] = Field(
      description=(
          "3-8 categories grouping all entries. Use a 'miscellaneous' "
          "category as a sink for entries that don't fit a multi-entry group, "
          "rather than fragmenting into many 1-entry categories."
      )
  )


_ENUMERATION_INSTRUCTION = """You are a knowledge-graph editor. Your job is to take a body of context (a compiled summary of multiple sources, optionally with a list of pre-existing entries that MUST appear in the output) and produce a CANONICAL, DEDUPLICATED, CATEGORIZED entry list.

CRITICAL RULES:

1. CANONICALIZATION. Two surface forms refer to the SAME entry if any of these apply:
   - They share most of their substantive words (e.g. "brewmax" and "brewmax-framework" -> same; "data-engineering-agent" and "data-engineering-agents" -> same).
   - One is an acronym of the other (e.g. "dea" and "data-engineering-agent" -> same; "ucp" and "universal-context-platform" -> same).
   - One is a sub-feature explicitly belonging to the other (e.g. "hatteras-online-prompt-evaluation" -> alias of "hatteras", not its own entry).
   When merging, pick the MOST FULLY SPELLED canonical form for `id` and `display_name`, and list every other form in `aliases`. Do NOT emit separate entries for the same underlying project.

2. CATEGORIZATION. Group entries into 3-8 categories by theme. Each category MUST contain 2+ entries — if an entry doesn't fit a multi-entry category, put it in a category called `miscellaneous` rather than creating a 1-entry category. Categories must be themed (e.g. "data-curation", "agent-orchestration", "evaluation"), not generic ("group-1", "other").

3. SEED ENTRIES (when provided). If the input lists pre-existing entries (table mode supplies tables this way), each one MUST appear in the output with the EXACT id given. You may add other entries discovered in the context, but seeded ones cannot be dropped or renamed.

4. SOURCE LINKING. For each entry, populate `primary_source_urls` with 1-5 of the most directly relevant source URLs from the context. These are used to scope the downstream writer's grounding — be specific, not exhaustive.

5. OUTPUT. Strict JSON conforming to the provided schema. No prose, no Markdown, no fenced blocks."""


def create_enumeration_runner(model: str) -> InMemoryRunner:
  """Canonicalizes + categorizes entries from context.

  Output is schema-validated JSON.
  """
  agent = llm_agent.LlmAgent(
      name="EnumerationAgent",
      description="Produces a canonical, deduplicated, categorized entry list.",
      model=VertexGemini(model=model),
      instruction=_ENUMERATION_INSTRUCTION,
      output_schema=EnumerationResult,
  )
  return InMemoryRunner(agent=agent)


def create_entry_writer_runner(model: str) -> InMemoryRunner:
  """Writes ONE entry's overview body. Fanned out per entry by both modes.

  Small per-call input (one entry's slice of context, typically <20K tokens)
  keeps us safely under the ADK 32K Flash routing cap, so Flash is the
  intended model here.
  """
  agent = llm_agent.LlmAgent(
      name="EntryWriterAgent",
      description=(
          "Writes one entry's overview Markdown body from grounded context."
      ),
      model=VertexGemini(model=model),
      instruction=ENTRY_WRITER_INSTRUCTION,
  )
  return InMemoryRunner(agent=agent)


ENTRY_WRITER_INSTRUCTION = """You are writing the overview prose for ONE knowledge catalog entry. You are given:
  - The entry's canonical name, description, and category.
  - The aliases that other sources use for the same entry.
  - The relevant context (excerpts of the source documents that mention this entry).

Write a rich, accurate Markdown OVERVIEW for this entry, grounded STRICTLY in the provided context.

GROUNDING RULES — do not make anything up:
  - Every statement must be supported by the provided context.
  - If the context is thin, the overview can be short — DO NOT pad with plausible-sounding generalities.
  - Keep all source-document links verbatim.

FACT COVERAGE — be thorough about what IS documented (without padding):
  - Document the table's KEY COLUMNS and explain what each one MEANS (its semantic / business role), grounded in the context. A `## Schema` or `## Key Columns` section that DEFINES columns is core catalog documentation and is valuable.
  - Capture the SPECIFIC facts the context states: exact values, qualifiers (e.g. "null when there is no accepted answer"), enum/code meanings (e.g. what a vote_type_id or a gold/silver/bronze class value means), lifecycle states, and metric formulas.
  - The value is the MEANING, not the restatement: give each column its definition/role — do NOT list a column as a bare name+type with nothing added.

STRUCTURE:
  - Start with a single H1 like `# {Display Name} Overview`.
  - Brief intro paragraph (1-3 sentences) on what this entry is.
  - Use H2 sections (`## Lineage`, `## Key Features`, `## Sample Usage`, `## Architecture`, etc.) as the context supports — DO NOT include sections you can't ground.
  - End with `## Source References` listing the context documents as `* [Title](URL)` markdown links.

OUTPUT RULES:
  - Output ONLY the Markdown body. Do NOT output YAML, do NOT output frontmatter, do NOT print file paths.
  - Fenced ```sql or ```python code blocks inside the body are allowed where the context supports them."""


# Context-overlay writer. Used by context_overlay_mode via
# common.generate_text_direct. Fuses the table's AUTHORITATIVE BASE ENTRY (the
# read-only 1P catalog entry pulled by `kcmd reference`) with routed document
# context into a NEW overlay entry's overview — preserve-and-augment, cite sources.
OVERLAY_WRITER_INSTRUCTION = """You are writing the enriched OVERVIEW prose for a context-overlay knowledge catalog entry that augments ONE BigQuery table.

You are given:
  - The AUTHORITATIVE BASE ENTRY: the real first-party (1P) catalog entry for this table — its full schema (every column + dataType + description) and its existing description/overview. This is the source of truth.
  - RELEVANT CONTEXT DOCUMENTS (zero or more) that a router determined pertain to this table, each with its title and source URL.

Write a rich, accurate Markdown OVERVIEW that FUSES the base entry with the document context.

PRESERVE-AND-AUGMENT (critical):
  - The overlay must be a SUPERSET of the base entry. Retain ALL of its information — never drop, rename, or shorten any column, dataType, or fact.
  - AUGMENT it with business/domain context from the documents: what the data represents, how it maps to the documented domain concepts, analytical use cases, lineage, and governance/usage notes.

GROUNDING RULES — do not make anything up:
  - Every statement must be supported by the base entry, the schema, or the provided context documents. Do NOT invent owners, SLAs, pipelines, or semantics.
  - Every claim drawn from a document MUST cite its source as an inline Markdown link.
  - If the documents are thin, the overview can be short — DO NOT pad with plausible-sounding generalities.

STRUCTURE:
  - Start with a single H1 like `# {Display Name} Overview`.
  - Use H2 sections (`## Schema`, `## Lineage`, `## Sample SQL`, `## Usage`, etc.) as the inputs support — omit any section you cannot ground.
  - Prefer a `## Sample SQL` section with fenced ```sql blocks that reference ONLY real columns and the fully-qualified `project.dataset.table` name when the inputs support it.
  - End with `## Source References` listing the context documents as `* [Title](URL)` markdown links. OMIT this section entirely if no documents informed the overview.

OUTPUT RULES:
  - Output ONLY the Markdown body. Do NOT output YAML, do NOT output frontmatter, do NOT print file paths.
  - Fenced ```sql or ```python code blocks inside the body are allowed where the context supports them."""


class GlossaryTerm(BaseModel):
  id: str = Field(description="kebab-case identifier for the glossary term.")
  display_name: str = Field(description="Human-readable name for the term.")
  description: str = Field(
      description="Clear, business-oriented definition of the term."
  )


class GlossaryResult(BaseModel):
  terms: list[GlossaryTerm] = Field(
      description="List of extracted business terms."
  )


_GLOSSARY_INSTRUCTION = """You are a business domain expert. Your job is to extract a canonical set of Business Glossary Terms from the provided context (database schemas, technical documentation, etc.).

RULES:
1. IDENTIFY BUSINESS CONCEPTS: Look for recurring entities, metrics, or domain-specific jargon that require a standard definition.
2. DEDUPLICATE: Merge similar concepts into a single canonical term.
3. BUSINESS-ORIENTED: Definitions should be clear to a non-technical business user.
4. NAMING: Use kebab-case for `id`, and Title Case for `display_name`.
5. OUTPUT: Strict JSON conforming to the provided schema."""


def create_glossary_runner(model: str) -> InMemoryRunner:
  """Extracts business terms from context."""
  agent = llm_agent.LlmAgent(
      name="GlossaryAgent",
      description="Extracts business glossary terms from context.",
      model=VertexGemini(model=model),
      instruction=_GLOSSARY_INSTRUCTION,
      output_schema=GlossaryResult,
  )
  return InMemoryRunner(agent=agent)


# ===================== Multi-turn refinement =====================
#
# After the initial enrichment, the agent can stay in an interactive REPL
# (agent_runner --interactive) and accept free-text refinement requests. Two
# pieces live here:
#   * REFINEMENT_WRITER_INSTRUCTION — re-writes ONE entry's overview, applying
#     the user's change while preserving still-valid content. Used via
#     common.generate_text_direct, reusing the SAME grounding context that
#     produced the original overview (so docs are never re-read).
#   * RefinementPlan + the dispatch runner — one schema-validated call that maps
#     a free-text request to a structured plan (which entries, what change, or a
#     direct answer to a question).
# See refine.py for the session model + REPL that drive these.

REFINEMENT_WRITER_INSTRUCTION = """You are REVISING an existing knowledge catalog entry's overview based on a user's refinement request.

You are given:
  - The ORIGINAL GROUNDING CONTEXT that was used to write the overview (topic, the entry's metadata/schema, and the relevant source documents). This is the same source of truth as before.
  - The CURRENT OVERVIEW (the Markdown body produced so far).
  - The REFINEMENT HISTORY: earlier changes already applied across previous turns (honor them — do not undo them).
  - The USER REFINEMENT REQUEST for this turn.

Your job: produce a REVISED overview that applies the user's request.

RULES:
  - Apply the requested change faithfully. If it asks to add/expand a section, add it; to shorten/remove, do so; to fix a fact, correct it.
  - PRESERVE everything in the current overview that is still valid and not contradicted by the request — do not drop content or regress earlier refinements.
  - Stay GROUNDED in the original grounding context. Do NOT invent facts, owners, SLAs, pipelines, or semantics that are not supported by the context or the user's explicit instruction.
  - If the request asks for something the context cannot support, apply what you can and keep the rest unchanged rather than fabricating.
  - Keep all source-document links that remain relevant.

OUTPUT RULES (identical to the original writer):
  - Output ONLY the revised Markdown body. Do NOT output YAML, do NOT output frontmatter, do NOT print file paths.
  - Fenced ```sql or ```python code blocks inside the body are allowed where the context supports them."""


class RefinementPlan(BaseModel):
  """Structured dispatch decision for one free-text refinement request."""

  operation: t.Literal["rewrite", "answer", "noop", "reenumerate"] = Field(
      description=(
          "'rewrite' to re-generate one or more entries' overviews with a"
          " change; 'reenumerate' to change WHICH entries exist (add a missing"
          " topic, remove a wrong one, split/merge, or re-categorize) by"
          " re-running enumeration over the already-loaded context; 'answer' to"
          " respond to a question about the output without changing any files;"
          " 'noop' when the request is unclear and needs clarification."
      )
  )
  target_entry_ids: list[str] = Field(
      default_factory=list,
      description=(
          "For 'rewrite': the entry ids to revise, chosen from the provided"
          " entry list. Use an EMPTY list to mean ALL entries (e.g. 'add a"
          " section to every table'). Ignored for 'answer'/'noop'/"
          "'reenumerate'."
      ),
  )
  instruction: str = Field(
      default="",
      description=(
          "For 'rewrite': a clear, self-contained restatement of the change to"
          " apply to each targeted entry (the per-entry writer sees only this"
          " plus the entry's own context). Empty for 'answer'/'noop'/"
          "'reenumerate'."
      ),
  )
  remove_entry_ids: list[str] = Field(
      default_factory=list,
      description=(
          "For 'reenumerate': entry ids the user wants DROPPED from the entry"
          " set (resolve names from the provided entry list to their ids)."
          " Empty for other operations."
      ),
  )
  enumeration_guidance: str = Field(
      default="",
      description=(
          "For 'reenumerate': a clear, self-contained instruction steering the"
          " re-enumeration — e.g. 'add a topic about X covering ...', 'split Y"
          " into A and B', 'these topics are too coarse, group them by Z'."
          " Empty for other operations."
      ),
  )
  answer: str = Field(
      default="",
      description=(
          "For 'answer': the response to show the user. For 'noop': a short"
          " clarifying question. Empty for 'rewrite'/'reenumerate'."
      ),
  )


_REFINEMENT_DISPATCH_INSTRUCTION = """You are the dispatcher for an interactive knowledge-catalog enrichment agent. The initial enrichment has finished and produced a set of entries, each with an overview. The user now types a free-text message; you decide what to do.

You will receive:
  - The user's message.
  - The list of current entries: each with its id, display name, category, and a short snippet of its current overview.

Choose ONE operation:
  - 'rewrite' — the user wants to change the CONTENT of one or more EXISTING overviews (make concise, add/remove a section, fix a fact, change tone, etc.). The set of entries stays the same. Resolve which entries they mean from their wording and the entry list:
      * a specific entry ("the orders table", a name) -> that entry's id in target_entry_ids.
      * all/every/each entry, or a global change -> EMPTY target_entry_ids (means ALL).
      * several named entries -> list each id.
    Put a clear, self-contained restatement of the requested change in `instruction` (the per-entry writer sees only `instruction` plus that entry's own grounding context, so do not rely on conversation history).
  - 'reenumerate' — the user thinks the ENTRY SET itself is wrong: a topic/entry is MISSING and should be added, an entry is incorrect/spurious and should be REMOVED, two entries should be split or merged, or the CATEGORIZATION is off. This re-runs enumeration over the already-loaded source context (it can surface a missing topic only if the original sources mention it). Fill:
      * `remove_entry_ids` — ids of entries the user wants dropped (resolve names from the entry list). Empty if none.
      * `enumeration_guidance` — a clear, self-contained instruction describing the desired change to the entry set (e.g. "add a topic about X covering ...", "split Y into A and B", "merge P and Q", "regroup the entries by lifecycle stage"). Leave `target_entry_ids`/`instruction` empty.
    Prefer 'reenumerate' over 'rewrite' whenever the request is about WHICH entries exist or how they are grouped, not the prose of a single existing overview.
  - 'answer' — the user is asking a QUESTION about the output (e.g. "why is X in that category?", "what did you cover for Y?"). Answer it directly in `answer` using the entry list/snippets. Change nothing.
  - 'noop' — the request is too vague to act on. Put a short clarifying question in `answer`.

Output strict JSON conforming to the schema. No prose, no Markdown, no fenced blocks."""


def create_refinement_dispatch_runner(model: str) -> InMemoryRunner:
  """Maps a free-text refinement request to a structured RefinementPlan.

  Schema-validated JSON output (same pattern as create_enumeration_runner).
  """
  agent = llm_agent.LlmAgent(
      name="RefinementDispatchAgent",
      description=(
          "Classifies a free-text refinement request into a structured plan."
      ),
      model=VertexGemini(model=model),
      instruction=_REFINEMENT_DISPATCH_INSTRUCTION,
      output_schema=RefinementPlan,
  )
  return InMemoryRunner(agent=agent)


# ============================ Linking Agent ============================


class ColumnLink(BaseModel):
  column_name: str = Field(description="Name of the BigQuery column.")
  term_fqn: str = Field(
      description=(
          "Full Resource Name (FQN) of the matched Glossary Term"
          " (projects/*/locations/*/glossaries/*/terms/*)."
      )
  )
  reason: str = Field(description="Brief technical rationale for the mapping.")


class TableLinkingResult(BaseModel):
  links: list[ColumnLink] = Field(
      description="List of discovered column-to-term links."
  )


_LINKING_INSTRUCTION = """You are a Metadata Governance Expert. Your mission is to map technical BigQuery columns to a canonical set of Business Glossary Terms.

CONTEXT PROVIDED:
1. ALLOWED GLOSSARY TERMS: A list of established terms with their IDs, Names, and Definitions.
2. EXISTING GOVERNANCE: A list of current mappings (Column -> Term) to help you understand established patterns.
3. TARGET TABLE SCHEMA: The schema of the table you are currently enriching.

GOAL:
For each column in the TARGET TABLE, determine if it matches the business definition of one (and only one) ALLOWED GLOSSARY TERM.

RULES:
- You MUST only use IDs from the ALLOWED GLOSSARY TERMS list.
- Do NOT create new terms.
- Only create a link if you are highly confident in the semantic match.
- If a column does not match any existing term, skip it.
- Focus on the 'definition' link type.

OUTPUT:
Strict JSON conforming to the TableLinkingResult schema."""


def create_linking_runner(model: str) -> InMemoryRunner:
  """Maps technical columns to glossary terms."""
  agent = llm_agent.LlmAgent(
      name="LinkingAgent",
      description="Maps table columns to glossary terms.",
      model=VertexGemini(model=model),
      instruction=_LINKING_INSTRUCTION,
      output_schema=TableLinkingResult,
  )
  return InMemoryRunner(agent=agent)


# ===================== Entity-level Linking Agent =====================
#
# For modes whose primary artifact is a non-tabular entry (KB pages, context
# overlays) rather than a BigQuery table schema. The link semantic shifts
# from "column → term" (precise definition) to "entry → term" (loose
# relatedness), so this agent emits `related` links anchored on the entry
# itself, with no Schema.<field> path. Output term count is unconstrained —
# the agent picks however many it judges relevant.


class EntityTermLink(BaseModel):
  term_fqn: str = Field(
      description=(
          "Full Resource Name (FQN) of the related Glossary Term"
          " (projects/*/locations/*/glossaries/*/terms/*)."
      )
  )
  reason: str = Field(
      description="Brief rationale for why this entry relates to this term."
  )


class EntityLinkingResult(BaseModel):
  links: list[EntityTermLink] = Field(
      description=(
          "Glossary terms this entry is related to. May be empty if no terms"
          " apply. No upper bound — include every term that the entry"
          " meaningfully covers or discusses."
      )
  )


_ENTITY_LINKING_INSTRUCTION = """You are a Metadata Governance Expert. Your mission is to identify which Business Glossary Terms a knowledge artifact is related to.

CONTEXT PROVIDED:
1. ALLOWED GLOSSARY TERMS: A list of established terms with their IDs, Names, and Definitions.
2. TARGET ENTRY: The title, type, and content summary of one knowledge artifact (a doc page or a context overlay describing a dataset table). This is what you are tagging.

GOAL:
Determine which ALLOWED GLOSSARY TERMS the TARGET ENTRY meaningfully covers, discusses, or governs. The relationship is broad ("related"), not strict definition equivalence.

RULES:
- You MUST only use IDs from the ALLOWED GLOSSARY TERMS list. Do NOT invent terms.
- Include every term the entry meaningfully covers — no upper limit, no quota.
- Skip terms the entry only mentions in passing or with low confidence.
- If no term applies, return an empty list.

OUTPUT:
Strict JSON conforming to the EntityLinkingResult schema."""


def create_entity_linking_runner(model: str) -> InMemoryRunner:
  """Maps a single entry (KB page or overlay) to a set of related glossary terms."""
  agent = llm_agent.LlmAgent(
      name="EntityLinkingAgent",
      description="Tags one entry with related glossary terms (entry-level).",
      model=VertexGemini(model=model),
      instruction=_ENTITY_LINKING_INSTRUCTION,
      output_schema=EntityLinkingResult,
  )
  return InMemoryRunner(agent=agent)
