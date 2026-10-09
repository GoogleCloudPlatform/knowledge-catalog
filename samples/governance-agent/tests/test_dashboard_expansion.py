import logging
import os

from metadata_propagation.agent.plugins.glossary_plugin import (
    GlossaryPlugin,
)
from metadata_propagation.agent.plugins.lineage_plugin import (
    LineagePlugin,
)

logging.basicConfig(level=logging.INFO)


import pytest


@pytest.mark.integration
def test_dashboard_logic():
    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT", "governance-agent")
    location = "europe-west1"
    dataset_id = "retail_syn_data"

    print(f"Testing Multi-dimensional Scan for dataset: {dataset_id}")

    lineage_plugin = LineagePlugin(project_id, location)
    glossary_plugin = GlossaryPlugin(project_id, location)

    # 1. Technical Scan
    desc_df = lineage_plugin.scan_for_missing_descriptions(dataset_id)
    print(f"Technical Gaps Found: {len(desc_df)}")

    # 2. Business Scan
    glossary_df = glossary_plugin.scan_for_missing_glossary_terms(dataset_id)
    print(f"Business Gaps Found: {len(glossary_df)}")

    # 3. Summary Generation Check
    desc_count = len(desc_df)
    gloss_count = len(glossary_df)

    summary = "### 📊 Governance Gap Analysis\n"
    summary += f"We found **{desc_count}** columns missing technical descriptions and **{gloss_count}** columns missing business glossary mappings.\n\n"
    print("\nGenerated Summary Preview:")
    print(summary)

    if not desc_df.empty:
        print("\nSample Technical Gaps (first 5):")
        print(desc_df.head())

    if not glossary_df.empty:
        print("\nSample Business Gaps (first 5):")
        print(glossary_df.head())


if __name__ == "__main__":
    test_dashboard_logic()
