import argparse
import csv
import logging
import os

from dotenv import load_dotenv
from google.cloud import bigquery

from .insights_connector import DataInsightsClient as DescriptionPropagator
from .lineage_propagation import LineageGraphTraverser

# Load configuration from .env
load_dotenv(override=True)

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def fetch_table_schema(project_id, dataset_id, table_id, credentials=None):
    client = bigquery.Client(project=project_id, credentials=credentials)
    table_ref = f"{project_id}.{dataset_id}.{table_id}"
    try:
        table = client.get_table(table_ref)
        return {field.name: field.description for field in table.schema}
    except Exception as e:
        logger.error(f"Error fetching table {table_ref}: {e}")
        return {}


def update_column_description(
    project_id, dataset_id, table_id, column_name, description, credentials=None
):
    client = bigquery.Client(project=project_id, credentials=credentials)
    table_ref = f"{project_id}.{dataset_id}.{table_id}"
    try:
        table = client.get_table(table_ref)
        new_schema = []
        for field in table.schema:
            if field.name == column_name:
                new_field = field.to_api_repr()
                new_field["description"] = description
                new_schema.append(bigquery.SchemaField.from_api_repr(new_field))
            else:
                new_schema.append(field)

        table.schema = new_schema
        client.update_table(table, ["schema"])
        logger.info(f"Updated description for {column_name} in {table_id}")
    except Exception as e:
        logger.error(f"Failed to update description for {column_name}: {e}")


def update_table_description(
    project_id, dataset_id, table_id, description, credentials=None
):
    """Updates the top-level description of a BigQuery table."""
    client = bigquery.Client(project=project_id, credentials=credentials)
    table_ref = f"{project_id}.{dataset_id}.{table_id}"
    try:
        table = client.get_table(table_ref)
        table.description = description
        client.update_table(table, ["description"])
        logger.info(f"Updated table description for {table_id}")
    except Exception as e:
        logger.error(f"Failed to update table description for {table_id}: {e}")


def log_for_steward_review(
    project_id,
    dataset_id,
    table_id,
    column,
    description,
    confidence,
    source_info,
):
    """Logs moderate confidence propagations to a local CSV file for Steward Review."""
    file_exists = os.path.isfile("steward_review_pending.csv")

    with open("steward_review_pending.csv", "a", newline="") as csvfile:
        fieldnames = [
            "project",
            "dataset",
            "table",
            "column",
            "proposed_description",
            "confidence",
            "source",
            "status",
        ]
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)

        if not file_exists:
            writer.writeheader()

        writer.writerow(
            {
                "project": project_id,
                "dataset": dataset_id,
                "table": table_id,
                "column": column,
                "proposed_description": description,
                "confidence": confidence,
                "source": source_info,
                "status": "PENDING",
            }
        )
    logger.info(
        f"Logged {table_id}.{column} for Steward Review (Confidence: {confidence})"
    )


def propagate_table_level(
    project_id,
    dataset_id,
    target_table,
    description_propagator,
    mode,
    credentials=None,
):
    """Propagates table-level descriptions (overviews) from insights."""
    client = bigquery.Client(project=project_id, credentials=credentials)
    table_ref = f"{project_id}.{dataset_id}.{target_table}"

    try:
        table = client.get_table(table_ref)
        if table.description:
            logger.info(
                f"Table {target_table} already has a description. Skipping."
            )
            return

        known_relationships = description_propagator.knowledge_json.get(
            "relationships", []
        )
        for rel in known_relationships:
            if rel.get("target_table") == target_table:
                overview = rel.get("table_overview")
                if overview:
                    logger.info(
                        f"Applying table-level overview to {target_table} (Source: Dataplex AI)"
                    )
                    if mode == "apply":
                        update_table_description(
                            project_id,
                            dataset_id,
                            target_table,
                            overview,
                            credentials=credentials,
                        )
                    return  # Only one overview per table

    except Exception as e:
        logger.error(
            f"Error in table-level propagation for {target_table}: {e}"
        )


def propagate_pull(
    project_id,
    dataset_id,
    target_table,
    lineage_traverser,
    description_propagator,
    mode,
    credentials=None,
):
    """
    Pulls metadata from Upstream -> Target Table
    """
    logger.info(f"--- Starting PULL Propagation for {target_table} ---")
    target_fqn = f"bigquery:{project_id}.{dataset_id}.{target_table}"

    # 1. Get Downstream Schema (Target)
    target_schema = fetch_table_schema(
        project_id, dataset_id, target_table, credentials=credentials
    )
    if not target_schema:
        return

    # 2. Find Upstream Sources
    upstream_columns_map = lineage_traverser.get_column_lineage(
        target_fqn, list(target_schema.keys())
    )

    # 3. Iterate through TARGET columns
    for target_col, current_desc in target_schema.items():
        if current_desc:
            logger.info(
                f"Column {target_col} already has a description. Skipping."
            )
            continue

        # Check Lineage API results (High Confidence)
        lineage_sources = upstream_columns_map.get(target_col, [])
        candidates = []

        if lineage_sources:
            # We found direct lineage from API! Take the best match.
            lineage_source = lineage_sources[0]
            source_table_entity = lineage_source["source_entity"]
            source_col = lineage_source["source_column"]

            clean_entity = source_table_entity.replace("bigquery:", "")
            parts = clean_entity.split(".")
            if len(parts) == 3:
                src_proj, src_ds, src_tab = parts
                src_schema = fetch_table_schema(
                    src_proj, src_ds, src_tab, credentials=credentials
                )
                src_desc = src_schema.get(source_col)

                if src_desc:
                    candidates.append(
                        {
                            "source_table": src_tab,
                            "source_col": source_col,
                            "confidence": 1.0,
                            "type": "DIRECT_PASSTHROUGH",
                            "desc": src_desc,
                        }
                    )

        # Dataset Insights fallback
        if not candidates:
            known_relationships = description_propagator.knowledge_json.get(
                "relationships", []
            )
            for rel in known_relationships:
                if rel.get("target_table") == target_table:
                    upstream_table = rel.get("source_table")
                    for mapping in rel.get("column_mappings", []):
                        if mapping.get("target_col") == target_col:
                            candidates.append(
                                {
                                    "source_table": upstream_table,
                                    "source_col": mapping.get("source_col"),
                                    "confidence": mapping.get("confidence"),
                                    "type": mapping.get("type"),
                                    "desc": mapping.get("explanation", ""),
                                }
                            )

        if candidates:
            best = max(candidates, key=lambda x: x["confidence"])
            confidence = best["confidence"]
            desc = best["desc"]
            source_info = f"{best.get('source_table')}.{best.get('source_col')}"

            if confidence > 0.90:
                logger.info(
                    f"High Confidence ({confidence}) for {target_col}: Auto-Applying."
                )
                if mode == "apply":
                    update_column_description(
                        project_id,
                        dataset_id,
                        target_table,
                        target_col,
                        desc,
                        credentials=credentials,
                    )
            elif confidence >= 0.70:
                logger.info(
                    f"Moderate Confidence ({confidence}) for {target_col}: Logging for Review."
                )
                if mode == "apply":
                    log_for_steward_review(
                        project_id,
                        dataset_id,
                        target_table,
                        target_col,
                        desc,
                        confidence,
                        source_info,
                    )
            else:
                logger.info(
                    f"Low confidence ({confidence}) for {target_col}: Skipping."
                )
        else:
            logger.info(f"No candidates found for {target_col}")

    logger.info("--- PULL Propagation Finished ---")


def propagate_push(
    project_id,
    dataset_id,
    source_table,
    lineage_traverser,
    description_propagator,
    mode,
    credentials=None,
):
    """
    Pushes metadata from Source Table -> Downstream Targets
    """
    logger.info(f"--- Starting PUSH Propagation from {source_table} ---")
    source_fqn = f"bigquery:{project_id}.{dataset_id}.{source_table}"

    # 1. Get Source Schema
    source_schema = fetch_table_schema(
        project_id, dataset_id, source_table, credentials=credentials
    )
    if not source_schema:
        logger.error("Could not fetch source schema.")
        return

    # 2. Find Downstream Targets for ALL columns
    downstream_map = lineage_traverser.get_downstream_lineage(
        source_fqn, list(source_schema.keys())
    )

    target_tables_updates = {}

    for source_col, targets in downstream_map.items():
        source_desc = source_schema.get(source_col)
        if not source_desc:
            logger.info(
                f"Source column {source_col} has no description to propagate."
            )
            continue

        for target in targets:
            target_table = target["target_table"]
            target_col = target["target_column"]
            if target_table not in target_tables_updates:
                target_tables_updates[target_table] = []

            target_tables_updates[target_table].append(
                {
                    "column": target_col,
                    "description": source_desc,
                    "source_col": source_col,
                }
            )

    # Apply Updates
    for t_table_ref, updates in target_tables_updates.items():
        parts = t_table_ref.split(".")
        if len(parts) == 3:
            t_proj, t_ds, t_tab = parts
        else:
            logger.warning(
                f"Skipping table ref {t_table_ref} (format not supported)"
            )
            continue

        t_schema = fetch_table_schema(
            t_proj, t_ds, t_tab, credentials=credentials
        )

        for update in updates:
            t_col = update["column"]
            current_desc = t_schema.get(t_col)
            new_desc = update["description"]
            source_info = f"{source_table}.{update['source_col']}"

            if current_desc:
                logger.info(
                    f"Target {t_tab}.{t_col} already has description. Skipping propagation from {update['source_col']}."
                )
            else:
                # Direct lineage is usually High Confidence 1.0
                confidence = 1.0

                if confidence > 0.90:
                    logger.info(
                        f"Propagating to {t_tab}.{t_col} from {source_info}: {new_desc}"
                    )
                    if mode == "apply":
                        update_column_description(
                            t_proj,
                            t_ds,
                            t_tab,
                            t_col,
                            new_desc,
                            credentials=credentials,
                        )
                elif confidence >= 0.70:
                    logger.info(
                        f"Moderate Confidence ({confidence}) for {t_tab}.{t_col}: Logging for Review."
                    )
                    if mode == "apply":
                        log_for_steward_review(
                            t_proj,
                            t_ds,
                            t_tab,
                            t_col,
                            new_desc,
                            confidence,
                            source_info,
                        )

    logger.info("--- PUSH Propagation Finished ---")


def main():
    parser = argparse.ArgumentParser(
        description="Propagate Metadata via Lineage"
    )
    parser.add_argument("--project_id", required=True)
    parser.add_argument("--dataset_id", required=True)
    parser.add_argument(
        "--target_table", help="Pull Mode: Propagate TO this table"
    )
    parser.add_argument(
        "--source_table", help="Push Mode: Propagate FROM this table"
    )
    parser.add_argument(
        "--entity_table",
        help="Chain Mode: Propagate TO this table, then FROM this table (Upstream -> Entity -> Downstream)",
    )
    parser.add_argument("--mode", choices=["report", "apply"], default="report")
    parser.add_argument(
        "--knowledge_json", help="Path to Dataset Insights JSON"
    )

    args = parser.parse_args()

    if not any([args.target_table, args.source_table, args.entity_table]):
        logger.error(
            "Must specify --target_table, --source_table, or --entity_table"
        )
        return

    # Initialize components
    lineage_traverser = LineageGraphTraverser(args.project_id, "europe-west1")

    # Load insights if provided (Enriching the Lineage Graph)
    if args.knowledge_json:
        logger.info(f"Loading Dataset Insights from {args.knowledge_json}")
        lineage_traverser.load_knowledge_insights(args.knowledge_json)

    description_propagator = DescriptionPropagator(args.knowledge_json)

    # 1. Chain Mode (Upstream -> Entity -> Downstream)
    if args.entity_table:
        logger.info(f"Running CHAIN MODE for entity: {args.entity_table}")
        # Phase 1: Pull
        propagate_pull(
            args.project_id,
            args.dataset_id,
            args.entity_table,
            lineage_traverser,
            description_propagator,
            args.mode,
        )
        # Phase 2: Push
        propagate_push(
            args.project_id,
            args.dataset_id,
            args.entity_table,
            lineage_traverser,
            description_propagator,
            args.mode,
        )
        return

    # 2. Push Mode
    if args.source_table:
        propagate_push(
            args.project_id,
            args.dataset_id,
            args.source_table,
            lineage_traverser,
            description_propagator,
            args.mode,
        )

    # 3. Pull Mode
    if args.target_table:
        propagate_table_level(
            args.project_id,
            args.dataset_id,
            args.target_table,
            description_propagator,
            args.mode,
        )
        propagate_pull(
            args.project_id,
            args.dataset_id,
            args.target_table,
            lineage_traverser,
            description_propagator,
            args.mode,
        )


if __name__ == "__main__":
    main()
