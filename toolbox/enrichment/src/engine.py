"""LLM agents for the unified enrichment agent (doc + table modes).

Doc mode:
  * SummarizerAgent      — map-reduce summarizer over crawled Google Docs.
  * MdcodeAgent          — emits the knowledge-base mdcode from the compiled summary.
Table mode:
  * DocSummarizerAgent   — distills ONE Drive doc into a compact router descriptor.
  * RelevanceRouterAgent — picks which docs are relevant to a given table.
  * TableOverviewAgent   — writes one table's enriched overview from its relevant docs.

Nothing here is project-specific: the model is supplied by the caller (the
`--model` CLI flag) and the Vertex project/location come from the environment
(`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`, set by the CLI from
`--project` / `--location`).
"""

import os

from google.adk.agents import llm_agent
from google.adk.runners import InMemoryRunner
from google.genai import Client
from google.adk.models import Gemini


class VertexGemini(Gemini):
  """Gemini on Vertex AI via Application Default Credentials. Project/location
  are read from the environment so the tool works in any customer project."""
  _cached_client = None

  @property
  def api_client(self) -> Client:
    if self._cached_client is None:
      from google.auth import default
      creds, _ = default()
      self._cached_client = Client(
          vertexai=True, credentials=creds,
          project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
          location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"))
    return self._cached_client


# ============================ Doc mode ============================

def create_summarizer_runner(model: str) -> InMemoryRunner:
    agent = llm_agent.LlmAgent(
        name="SummarizerAgent",
        description="Summarizes Google Drive documents.",
        model=VertexGemini(model=model),
        instruction="""You are an expert technical summarizer for a Metadata as Code generation pipeline.
Given a topic, a MASTER SCOPE document, and a batch of raw Google Documents:
1. Understand the overarching projects and goals from the MASTER SCOPE.
2. For each document in the batch, extract all relevant architectural requirements, proposals, and details.
3. STRUCTURED EXTRACTION: You MUST map every finding to one of the overarching projects defined in the MASTER SCOPE. Do not create orphaned topics.
4. SOURCE TRACKING: You MUST append an explicit "Source References" section to every single finding or sub-topic you extract. Instead of using raw URLs, you MUST format the sources as Markdown links using the Document's Title (inferred from the document content) as the link text (e.g., `[Document Title](URL)`). Do not drop URLs.
5. Do not output final mdcode formats; output a structured, dense markdown summary grouping findings by the Master Scope projects."""
    )
    return InMemoryRunner(agent=agent)


_MDCODE_INSTRUCTION = """You are an expert Document Knowledge Base Enrichment Agent for Google Cloud Dataplex.

Your workflow:
1. You will receive a compiled summary of multiple Google Docs regarding a specific topic.
2. Analyze and Split: Thoroughly understand the summary. Extract and divide the information into logical, concrete sub-topics.
3. Map to Entries: Map each sub-topic to an individual Dataplex entry of type `__ENTRY_TYPE__`.
4. Create Aspects: For each sub-topic, synthesize all relevant information and format them as Markdown sidecar files (Aspects) attached to the entry.
5. Output mdcode: Your final output must strictly follow the Metadata-as-Code (mdcode) YAML standard.
   - Do NOT output a `catalog.yaml` manifest — it is generated separately by the CLI. Output ONLY the entry files and their markdown sidecars.
   - You MUST generate an Entry for EVERY top-level project identified in the compiled summary. Do not drop any project. Ensure all collected source URLs are populated in the Overview sidecar under a 'Source References' section, strictly formatted as Markdown links using the Document Title (e.g., `* [Document Title](URL)`).
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


def create_mdcode_runner(model: str, entry_type: str, resource_name_prefix: str) -> InMemoryRunner:
    instruction = (_MDCODE_INSTRUCTION
                   .replace("__ENTRY_TYPE__", entry_type)
                   .replace("__RESOURCE_NAME_PREFIX__", resource_name_prefix))
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
        description="Summarizes a single Drive document into a compact descriptor.",
        model=VertexGemini(model=model),
        instruction="""You are summarizing ONE document so a router can decide which BigQuery tables it is relevant to.

Output EXACTLY this Markdown shape and nothing else:

Title: <the document's inferred title>
Summary: <2-4 sentences on what data/system/domain this document describes>
Key entities: <comma-separated tables, datasets, columns, metrics, systems, or business terms this document actually discusses>

Be concrete and faithful — list the specific entities/columns/metrics named in the document. Do not invent. Do not add any other sections.""",
    )
    return InMemoryRunner(agent=agent)


def create_router_runner(model: str) -> InMemoryRunner:
    """Decides which folder docs are relevant to a single table."""
    agent = llm_agent.LlmAgent(
        name="RelevanceRouterAgent",
        description="Scores folder-document relevance to one BigQuery table.",
        model=VertexGemini(model=model),
        instruction="""You are a precise relevance router. You are given ONE BigQuery table (its name and columns) and a numbered list of candidate documents (each with a title, summary, and key entities).

Decide which documents genuinely provide domain knowledge that would help DOCUMENT THIS SPECIFIC TABLE — e.g. they define this table, its columns/metrics, its source system, or the business process it records. A document that merely shares a broad theme but does not concern this table's data is NOT relevant.

Output ONLY a JSON array (no prose, no code fences). Each element: {"doc": <number>, "score": <0.0-1.0>, "reason": "<short reason>"}. Include an element ONLY for documents with score >= 0.3; if none qualify, output []. Be conservative — prefer precision over recall.""",
    )
    return InMemoryRunner(agent=agent)


def create_table_overview_runner(model: str) -> InMemoryRunner:
    """Writes the enriched OVERVIEW prose for one table (the caller assembles the
    mdcode files deterministically)."""
    agent = llm_agent.LlmAgent(
        name="TableOverviewAgent",
        description="Writes the enriched overview for one BigQuery table from its relevant docs.",
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
