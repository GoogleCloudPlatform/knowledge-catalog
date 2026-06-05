"""Unified enrichment agent entrypoint.

Dispatches to one of two flows based on `--mode`:
  * doc   — recursive Google-Docs crawl -> map-reduce summarize -> LLM-emitted
            knowledge-base mdcode entries (manifest scaffolded by `kcmd init --kb`).
  * table — kcmd-pulled BigQuery dataset discovery -> relevance-routed,
            folder-grounded table overviews (kcmd bq-dataset format).

When `--mode` is empty it is inferred: a `--dataset` implies table, else doc.

The agent runs the READ-ONLY kcmd commands itself (`init`, `pull`); generating
`catalog.yaml` + the local entries. The customer runs `kcmd push` to publish.

Nothing is project-specific: pass your own `--project`, `--location`, and
`--model`; for doc mode also pass `--entry-group`.
"""

import asyncio
import os

from absl import app
from absl import flags

from modes import doc_mode, table_mode

_MODE = flags.DEFINE_enum("mode", "", ["", "doc", "table"],
                          "Which enrichment flow to run. Empty = infer from flags.")
_TOPIC = flags.DEFINE_string("topic", "Metadata enrichment",
                             "Free-text use case / instruction guiding enrichment (anything).")
_DOCS = flags.DEFINE_list("docs", [], "Comma-separated list of Google Doc URLs or IDs (doc mode).")
_FOLDER = flags.DEFINE_string("folder", None, "Optional Google Drive folder ID/URL to seed from.")
_DATASET = flags.DEFINE_string("dataset", "", "BigQuery dataset as `project.dataset` (table mode).")
_OUTPUT_DIR = flags.DEFINE_string("output_dir", None, "Local directory path for the generated mdcode.")

# Customer-supplied GCP + model configuration (nothing is hardcoded).
_PROJECT = flags.DEFINE_string("project", None, "Google Cloud project for the Vertex AI model (required).")
_LOCATION = flags.DEFINE_string("location", "global", "Vertex AI location for the model.")
_MODEL = flags.DEFINE_string("model", None, "Model for the agent, e.g. `gemini-2.5-pro` (required).")
_ENTRY_GROUP = flags.DEFINE_string("entry_group", None,
                                   "Knowledge Base entry group `project.location.entryGroupId` (doc mode).")


def main(argv):
    if len(argv) > 1:
        raise app.UsageError("Too many command-line arguments.")
    if not _PROJECT.value:
        raise app.UsageError("--project is required (your Google Cloud project).")
    if not _MODEL.value:
        raise app.UsageError("--model is required (e.g. --model=gemini-2.5-pro).")

    # Configure Vertex AI for the agent's model from the customer's flags.
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "True"
    os.environ["GOOGLE_CLOUD_PROJECT"] = _PROJECT.value
    os.environ["GOOGLE_CLOUD_LOCATION"] = _LOCATION.value

    mode = _MODE.value or ("table" if _DATASET.value else "doc")

    if mode == "table":
        asyncio.run(table_mode.run(
            _DATASET.value, _FOLDER.value, _TOPIC.value, _OUTPUT_DIR.value, _MODEL.value))
    else:
        if not _ENTRY_GROUP.value:
            raise app.UsageError(
                "--entry_group is required for doc mode "
                "(`project.location.entryGroupId`).")
        asyncio.run(doc_mode.run(
            _TOPIC.value, _DOCS.value, _FOLDER.value, _OUTPUT_DIR.value,
            _MODEL.value, _ENTRY_GROUP.value))


if __name__ == "__main__":
    app.run(main)
