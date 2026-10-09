import os
import shutil
import tempfile

# Force gRPC to use native IPv4 resolver to bypass macOS IPv6 lookup hangs/timeouts
os.environ["GRPC_DNS_RESOLVER"] = "native"
os.environ["GRPC_IPv6"] = "off"

import argparse
import sys

import pandas as pd
from dotenv import load_dotenv

# Load configurations from .env
load_dotenv(override=True)

import logging
import tempfile

try:
    from metadata_propagation.agent.plugins.doc_description_plugin import (
        DocDescriptionPlugin,
    )
    from metadata_propagation.agent.plugins.dq_plugin import DQPlugin
    from metadata_propagation.agent.plugins.glossary_plugin import (
        GlossaryPlugin,
    )
    from metadata_propagation.agent.plugins.lineage_plugin import (
        LineagePlugin,
    )
    from metadata_propagation.agent.plugins.policy_tag_plugin import (
        PolicyTagPlugin,
    )
    from metadata_propagation.dataplex_integration import (
        propagate_metadata,
    )
    from metadata_propagation.dataplex_integration.dq_propagation import (
        DQPropagationEngine,
    )
    from metadata_propagation.dataplex_integration.insights_connector import (
        DataInsightsClient,
    )
except ImportError as e:
    print(f"Error: Could not import Plugins. {e}")
    sys.exit(1)


def print_beautiful_table(df: pd.DataFrame, col_widths: dict | None = None):
    """Formats and prints a pandas DataFrame beautifully for the terminal."""
    import textwrap

    if df.empty:
        print("No data available.")
        return

    if not col_widths:
        col_widths = {}
        for col in df.columns:
            max_len = max(df[col].astype(str).map(len).max(), len(col))
            col_widths[col] = min(max(max_len, 10), 40)

    border = "+" + "+".join(["-" * (w + 2) for w in col_widths.values()]) + "+"
    header_row = (
        "|"
        + "|".join(
            [
                f" \033[1m{col:<{col_widths[col]}}\033[0m "
                for col in col_widths.keys()
            ]
        )
        + "|"
    )

    print(border)
    print(header_row)
    print(border.replace("-", "="))

    for _, row in df.iterrows():
        col_lines = {}
        max_lines = 1

        for col in col_widths.keys():
            val = str(row.get(col, ""))
            val = val.replace("\n", " ").replace("\r", " ")
            lines = textwrap.wrap(val, width=col_widths[col])
            if not lines:
                lines = [""]
            col_lines[col] = lines
            max_lines = max(max_lines, len(lines))

        for line_idx in range(max_lines):
            row_parts = []
            for col in col_widths.keys():
                lines = col_lines[col]
                text = lines[line_idx] if line_idx < len(lines) else ""

                if col in ["Confidence", "Trust"] or "Score" in col:
                    try:
                        num_val = float(text)
                        text = f"{num_val:.2f}"
                        row_parts.append(f" {text:>{col_widths[col]}} ")
                    except ValueError:
                        row_parts.append(f" {text:<{col_widths[col]}} ")
                else:
                    row_parts.append(f" {text:<{col_widths[col]}} ")
            print("|" + "|".join(row_parts) + "|")
        print(border)


def main():
    parser = argparse.ArgumentParser(description="Agentic Data Steward CLI")
    parser.add_argument(
        "--project",
        "--project_id",
        dest="project",
        default=os.environ.get("GOOGLE_CLOUD_PROJECT", "governance-agent"),
        help="GCP Project ID",
    )
    parser.add_argument(
        "--location", default="europe-west1", help="GCP Location"
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Automatically approve all prompts",
    )
    parser.add_argument(
        "--debug", action="store_true", help="Enable debug logging to file"
    )
    parser.add_argument(
        "--cache-dataset",
        dest="cache_dataset",
        default=os.environ.get("GLOSSARY_CACHE_DATASET_ID"),
        help="GCP BigQuery dataset for glossary embeddings cache",
    )
    parser.add_argument(
        "--cache-table",
        dest="cache_table",
        default=os.environ.get("GLOSSARY_CACHE_TABLE_ID"),
        help="GCP BigQuery table name for glossary embeddings cache",
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Scan command
    scan_parser = subparsers.add_parser(
        "scan", help="Scan dataset for missing descriptions"
    )
    scan_parser.add_argument(
        "--dataset",
        "--dataset_id",
        dest="dataset",
        required=True,
        help="BigQuery Dataset ID",
    )

    # Apply command
    apply_parser = subparsers.add_parser(
        "apply", help="Preview and apply description propagation for a table"
    )
    apply_parser.add_argument(
        "--dataset",
        "--dataset_id",
        dest="dataset",
        required=True,
        help="BigQuery Dataset ID",
    )
    apply_parser.add_argument(
        "--table",
        "--table_id",
        dest="table",
        required=True,
        help="BigQuery Table ID",
    )
    # Document context options for description propagation
    apply_parser.add_argument(
        "--document",
        nargs="+",
        help="Path to unstructured document(s) to influence descriptions",
    )
    apply_parser.add_argument(
        "--context-mode",
        choices=["direct", "rag", "datastore"],
        default="rag",
        help="Mode to process document context",
    )
    apply_parser.add_argument(
        "--datastore-id",
        help="Vertex AI Search DataStore ID (required for datastore mode)",
    )
    apply_parser.add_argument(
        "--force",
        action="store_true",
        help="Force propagation analysis even for columns that already have descriptions",
    )
    apply_parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="Disable general LLM fallback description generation if data dictionary and lineage matches are missing",
    )
    apply_parser.add_argument(
        "--force-cache",
        action="store_true",
        help="Force recreate document extraction even if already cached",
    )

    # Glossary recommend command
    glossary_parser = subparsers.add_parser(
        "glossary-recommend", help="Recommend glossary terms for a table"
    )
    glossary_parser.add_argument(
        "--dataset",
        "--dataset_id",
        dest="dataset",
        required=True,
        help="BigQuery Dataset ID",
    )
    glossary_parser.add_argument(
        "--table",
        "--table_id",
        dest="table",
        required=True,
        help="BigQuery Table ID",
    )
    glossary_parser.add_argument(
        "--document",
        nargs="+",
        help="Path to unstructured document(s) for context",
    )
    glossary_parser.add_argument(
        "--context-mode",
        choices=["direct", "rag", "datastore"],
        default="rag",
        help="Mode for processing document context",
    )
    glossary_parser.add_argument(
        "--datastore-id",
        help="Vertex AI Search DataStore ID (required for datastore mode)",
    )

    # Policy Tag scan command
    policy_scan_parser = subparsers.add_parser(
        "policy-scan", help="Scan dataset for existing policy tags"
    )
    policy_scan_parser.add_argument(
        "--dataset",
        "--dataset_id",
        dest="dataset",
        required=True,
        help="BigQuery Dataset ID",
    )

    policy_propagate_parser = subparsers.add_parser(
        "policy-propagate",
        help="Recommend and optionally apply policy tag propagation for a table",
    )
    policy_propagate_parser.add_argument(
        "--dataset",
        "--dataset_id",
        dest="dataset",
        required=True,
        help="BigQuery Dataset ID",
    )
    policy_propagate_parser.add_argument(
        "--table",
        "--table_id",
        dest="table",
        required=True,
        help="BigQuery Table ID",
    )
    policy_propagate_parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply recommendations directly without confirmation",
    )
    policy_propagate_parser.add_argument(
        "--propagate-access",
        action="store_true",
        help="Also propagate Fine-Grained Access Control (IAM) from source tags",
    )
    policy_propagate_parser.add_argument(
        "--readers",
        help="Comma-separated list of additional readers to add to the policy tags",
    )
    policy_propagate_parser.add_argument(
        "--document",
        nargs="+",
        help="Path to unstructured document(s) (PDF/TXT/MD) for context",
    )
    policy_propagate_parser.add_argument(
        "--context-mode",
        choices=["direct", "rag", "datastore"],
        default="rag",
        help="Mode for processing document context",
    )
    policy_propagate_parser.add_argument(
        "--datastore-id",
        help="Vertex AI Search DataStore ID (required for datastore mode)",
    )

    # DQ Propagate command
    dq_propagate_parser = subparsers.add_parser(
        "dq-propagate",
        help="Analyze and propagate trust/DQ scores for a table or view",
    )
    dq_propagate_parser.add_argument(
        "--dataset",
        "--dataset_id",
        dest="dataset",
        required=True,
        help="BigQuery Dataset ID",
    )
    dq_propagate_parser.add_argument(
        "--table",
        "--table_id",
        dest="table",
        required=True,
        help="BigQuery Table or View ID",
    )

    # Knowledge Catalog Propagate command (Unified)
    dataplex_propagate_parser = subparsers.add_parser(
        "knowledge-propagate",
        aliases=["dataplex-propagate"],
        help="End-to-end Knowledge Catalog AI Insight propagation (Trigger -> Extract -> Apply)",
    )
    dataplex_propagate_parser.add_argument(
        "--dataset",
        "--dataset_id",
        dest="dataset",
        required=True,
        help="BigQuery Dataset ID",
    )
    dataplex_propagate_parser.add_argument(
        "--table",
        "--table_id",
        dest="table",
        help="Specific BigQuery Table ID (optional)",
    )
    dataplex_propagate_parser.add_argument(
        "--apply", action="store_true", help="Apply updates to BigQuery"
    )

    # Clear RAG Cache command
    subparsers.add_parser(
        "clear-cache",
        help="Clear local and system RAG cache files",
    )

    args = parser.parse_args()

    if args.command == "clear-cache":
        cache_dir = os.path.join(
            tempfile.gettempdir(), "governance_agent_rag_cache"
        )
        if os.path.exists(cache_dir):
            shutil.rmtree(cache_dir)
            print(f"✅ Cleared RAG cache directory: {cache_dir}")
        else:
            print("ℹ️ RAG cache directory does not exist or is already empty.")
        return

    # Configure logging based on debug flag
    log_file_path = None
    if args.debug:
        log_file = tempfile.NamedTemporaryFile(
            delete=False, prefix="steward_", suffix=".log"
        )
        log_file_path = log_file.name
        log_file.close()
        print(f"Logging detailed execution to: {log_file_path}")

    root_logger = logging.getLogger()
    # Clear existing handlers to prevent double printing
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    root_logger.setLevel(logging.DEBUG if args.debug else logging.INFO)

    # Only log to file if debug is enabled to avoid filling up disk
    if args.debug:
        fh = logging.FileHandler(log_file_path)
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(
            logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
        )
        root_logger.addHandler(fh)

    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(
        logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
    )
    root_logger.addHandler(ch)

    plugin = LineagePlugin(args.project, args.location)
    glossary_plugin = GlossaryPlugin(
        args.project,
        args.location,
        cache_dataset_id=args.cache_dataset,
        cache_table_id=args.cache_table,
    )
    policy_plugin = PolicyTagPlugin(args.project, args.location)
    DocDescriptionPlugin(args.project, args.location)

    if args.command == "scan":
        print(
            f"Scanning dataset '{args.dataset}' in project '{args.project}'..."
        )
        df = plugin.scan_for_missing_descriptions(args.dataset)
        if df.empty:
            print("No missing descriptions found!")
        else:
            print("\nMissing Descriptions:")
            print(df.to_string(index=False))

    elif args.command == "apply":
        if args.context_mode == "datastore":
            if not args.datastore_id:
                print(
                    "Error: --datastore-id is required when --context-mode is 'datastore'"
                )
                sys.exit(1)
            if args.datastore_id.startswith("https://"):
                print("Error: Invalid --datastore-id format.")
                print("Expected formats:")
                print("  1. Short ID: e.g., 'my-datastore-id'")
                print(
                    "  2. Full Resource Path: e.g., 'projects/my-project/locations/global/collections/default_collection/dataStores/my-datastore-id'"
                )
                print("Do not provide the full API URL starting with https://")
                sys.exit(1)

        print(f"Analyzing lineage for '{args.dataset}.{args.table}'...")
        df = plugin.preview_propagation(
            args.dataset,
            args.table,
            document_path=args.document,
            context_mode=args.context_mode,
            datastore_id=args.datastore_id,
            force=args.force,
            fallback_to_llm=not args.no_fallback,
            force_refresh=args.force_cache,
        )

        if df.empty:
            print("No propagation candidates found.")
            return

        print("\nProposed Description Updates:")
        # Display relevant columns
        display_df = df[
            ["Target Column", "Source", "Proposed Description", "Confidence"]
        ]
        widths = {
            "Target Column": 18,
            "Source": 20,
            "Proposed Description": 50,
            "Confidence": 10,
        }
        print_beautiful_table(display_df, widths)

        if args.yes:
            do_apply = True
        else:
            confirm = input("\nApply these updates to BigQuery? (y/N): ")
            do_apply = confirm.lower() == "y"

        if do_apply:
            print("Applying updates...")
            updates = []
            for _, row in df.iterrows():
                updates.append(
                    {
                        "table": args.table,
                        "column": row["Target Column"],
                        "description": row["Proposed Description"],
                    }
                )
            plugin.apply_propagation(args.dataset, updates)
            print("Successfully updated metadata in BigQuery.")
        else:
            print("Operation cancelled.")

    elif args.command == "glossary-recommend":
        print(
            f"Fetching glossary recommendations for '{args.dataset}.{args.table}'..."
        )
        df = glossary_plugin.recommend_terms_for_table(
            args.dataset,
            args.table,
            doc_path=args.document,
            context_mode=args.context_mode,
            datastore_id=args.datastore_id,
        )

        if df.empty:
            print("No recommendations found.")
        else:
            print("\nGlossary Term Recommendations:")
            cols_to_show = [
                c
                for c in [
                    "Column",
                    "Suggested Term",
                    "Term Status",
                    "Confidence",
                    "Rationale",
                ]
                if c in df.columns
            ]
            widths = {
                "Column": 18,
                "Suggested Term": 22,
                "Term Status": 22,
                "Confidence": 10,
                "Rationale": 45,
            }
            print_beautiful_table(
                df[cols_to_show],
                {k: v for k, v in widths.items() if k in cols_to_show},
            )
            print(
                "\nNote: Use the UI or a separate apply command to persist these mappings."
            )

    elif args.command == "policy-scan":
        print(f"Scanning dataset '{args.dataset}' for existing policy tags...")
        df = policy_plugin.scan_for_policy_tags(args.dataset)
        if df.empty:
            print("No policy tags found in this dataset.")
        else:
            print("\nExisting Policy Tags:")
            print(df.to_string(index=False))

    elif args.command == "policy-propagate":
        print(
            f"Analyzing policy tag propagation for '{args.dataset}.{args.table}'..."
        )
        df = policy_plugin.preview_policy_tag_propagation(
            args.dataset,
            args.table,
            doc_path=args.document,
            context_mode=args.context_mode,
            datastore_id=args.datastore_id,
        )

        if df.empty:
            print("No policy tag propagation recommendations found.")
        else:
            print("\nPolicy Tag Propagation Recommendations:")
            cols_to_show = [
                "Target Column",
                "Source Table",
                "Policy Tags",
                "Recommendation",
                "Logic",
                "Access Summary",
            ]
            widths = {
                "Target Column": 16,
                "Source Table": 15,
                "Policy Tags": 20,
                "Recommendation": 15,
                "Logic": 25,
                "Access Summary": 25,
            }
            print_beautiful_table(df[cols_to_show], widths)

            if args.apply:
                do_apply = True
            elif args.yes:
                do_apply = True
            else:
                confirm = input(
                    "\nApply these policy tags (and access if requested) to BigQuery? (y/N): "
                )
                do_apply = confirm.lower() == "y"

            if do_apply:
                print("Applying policy tags...")
                updates = []
                for _, row in df.iterrows():
                    update = {
                        "table": args.table,
                        "column": row["Target Column"],
                        "policy_tag": row["Policy Tags"].split(", ")[0],
                    }

                    # Merge additional readers
                    all_readers = []
                    if args.readers:
                        all_readers.extend(
                            [
                                r.strip()
                                for r in args.readers.split(",")
                                if r.strip()
                            ]
                        )

                    if all_readers:
                        update["readers"] = list(
                            set(all_readers)
                        )  # De-duplicate

                    updates.append(update)
                policy_plugin.apply_policy_tags(args.dataset, updates)
                print(
                    "Successfully updated policy tags and access in BigQuery."
                )
            else:
                print("Operation cancelled.")

    elif args.command == "dq-propagate":
        from metadata_propagation.agent.plugins.dq_plugin import (
            DQPlugin,
        )
        from metadata_propagation.dataplex_integration.dq_propagation import (
            DQPropagationEngine,
        )

        print(
            f"Analyzing Trust & Quality for '{args.dataset}.{args.table}' (Multi-hop Lineage)..."
        )
        dq_plugin = DQPlugin(args.project, args.location)
        engine = DQPropagationEngine(args.project, args.location)

        target_fqn = f"bigquery:{args.project}.{args.dataset}.{args.table}"

        # We need to list columns to analyze
        from google.cloud import bigquery

        from metadata_propagation.agent.plugins.context import (
            get_credentials,
        )

        client = bigquery.Client(
            project=args.project, credentials=get_credentials(args.project)
        )
        table = client.get_table(f"{args.project}.{args.dataset}.{args.table}")
        columns = [f.name for f in table.schema]

        # 1. Perform multi-hop propagation analysis
        propagation_data = engine.propagate_dq_scores(
            target_fqn, args.dataset, args.table, columns
        )

        results = []
        for col in columns:
            data = propagation_data.get(col, {})
            leaves = data.get("leaves", [])
            bonus = data.get("bonus", 0.0)

            upstream_scores = []
            source_names = []
            for leaf in leaves:
                src_parts = leaf["source_entity"].split(".")
                if len(src_parts) == 3:
                    s_ds, s_tab = src_parts[1], src_parts[2]
                    # Fetch granular score for specific upstream column
                    s_summary = dq_plugin.fetch_dq_summary(
                        s_ds, s_tab, leaf.get("source_column")
                    )
                    upstream_scores.append(s_summary["score"])
                    source_names.append(f"{s_tab}.{leaf.get('source_column')}")

            if not upstream_scores:
                # Fallback to direct table scan if no lineage found
                summary = dq_plugin.fetch_dq_summary(
                    args.dataset, args.table, col
                )
                base_score = summary["score"]
                source_type = summary["source"]
            else:
                base_score = engine.aggregate_scores(upstream_scores)
                source_type = "DERIVED"

            final_score = min(base_score + bonus, 1.0)

            # 2. Persist to history (JSON & BQ)
            engine.update_history(
                target_fqn, col, final_score, source_type=source_type
            )
            trend = engine.get_trend(target_fqn, col)

            badge = (
                "🟢 High"
                if final_score > 0.9
                else ("🟡 Medium" if final_score > 0.7 else "🔴 Low")
            )

            results.append(
                {
                    "Column": col,
                    "Trust": round(final_score, 2),
                    "Badge": badge,
                    "Trend": trend.capitalize(),
                    "Source Path": ", ".join(source_names[:2])
                    + ("..." if len(source_names) > 2 else ""),
                    "Bonus": f"+{int(bonus * 100)}%" if bonus > 0 else "0%",
                }
            )

        df = pd.DataFrame(results)
        print("\nColumn Trust Metrics (Calculated from Upstream Leaves):")
        widths = {
            "Column": 18,
            "Trust": 8,
            "Badge": 10,
            "Trend": 10,
            "Source Path": 25,
            "Bonus": 8,
        }
        print_beautiful_table(df, widths)
        print(
            "\nNote: Trust history for these columns has been updated and persisted to BigQuery."
        )

    elif args.command in ["knowledge-propagate", "dataplex-propagate"]:
        from metadata_propagation.dataplex_integration import (
            propagate_metadata,
        )
        from metadata_propagation.dataplex_integration.insights_connector import (
            DataInsightsClient,
        )
        from metadata_propagation.dataplex_integration.insights_connector import (
            DataInsightsClient as DescriptionPropagator,
        )
        from metadata_propagation.dataplex_integration.lineage_propagation import (
            LineageGraphTraverser,
        )

        print(
            f"🚀 Starting Unified Knowledge Catalog Insights Workflow for {args.dataset}{'.' + args.table if args.table else ''}..."
        )

        client = DataInsightsClient(
            project_id=args.project, location=args.location
        )

        # 1. Trigger -> Wait -> Extract
        print("--- Phase 1: Knowledge Catalog AI Scan & Extraction ---")
        insights = client.run_full_sync(
            dataset_id=args.dataset, table_id=args.table
        )

        if not insights:
            print("❌ Failed to retrieve insights from Knowledge Catalog.")
            return

        # 2. Apply (Pull Mode)
        print("\n--- Phase 2: Metadata Propagation ---")
        mode = "apply" if args.apply else "report"
        knowledge_json = "knowledge_insights.json"

        # Initialize propagation components
        lineage_traverser = LineageGraphTraverser(args.project, args.location)
        lineage_traverser.load_knowledge_insights(knowledge_json)
        description_propagator = DescriptionPropagator(args.project)
        description_propagator.knowledge_json = (
            insights  # Use results from memory
        )

        tables_to_sync = [args.table] if args.table else []
        if not args.table:
            # If no table specified, extract target tables from the insights we just generated
            tables_to_sync = list(
                {
                    rel.get("target_table")
                    for rel in insights.get("relationships", [])
                }
            )

        for table in tables_to_sync:
            if not table:
                continue
            print(f"\nSyncing metadata for table: {table}")
            propagate_metadata.propagate_table_level(
                args.project, args.dataset, table, description_propagator, mode
            )
            propagate_metadata.propagate_pull(
                args.project,
                args.dataset,
                table,
                lineage_traverser,
                description_propagator,
                mode,
            )

        print("\n✅ Knowledge Catalog Insights propagation complete.")

    else:
        parser.print_help()

    if args.debug:
        print(
            f"\nℹ️ Detailed execution logs (including DEBUG level) are available at: {log_file_path}"
        )


if __name__ == "__main__":
    main()
