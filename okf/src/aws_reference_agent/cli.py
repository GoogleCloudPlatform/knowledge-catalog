from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from urllib.parse import urlparse

from aws_reference_agent.agent import DEFAULT_MODEL
from aws_reference_agent.bundle.paths import parse_concept_id
from aws_reference_agent.runner import ReferenceRunner
from aws_reference_agent.verification import VERIFY_MODES, VerifyMode

_SOURCES = ("glue",)


def _build_source(name: str, args: argparse.Namespace):
    if name == "glue":
        from aws_reference_agent.sources.glue import GlueSource

        if not args.database:
            raise SystemExit("--database is required for --source glue")
        return GlueSource(
            database=args.database,
            region=args.region,
            profile=args.profile,
            athena_workgroup=args.athena_workgroup,
            athena_output_location=args.athena_output_location,
            sampling_enabled=not args.no_sample,
        )
    raise SystemExit(f"Unknown source: {name}")


def _parse_seed_file(path: Path) -> list[str]:
    urls: list[str] = []
    text = path.read_text(encoding="utf-8")
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            urls.append(line)
    return urls


def _collect_seeds(args: argparse.Namespace) -> list[str]:
    if args.no_web:
        return []
    seeds: list[str] = []
    if args.web_seed:
        seeds.extend(args.web_seed)
    if args.web_seed_file:
        for p in args.web_seed_file:
            seeds.extend(_parse_seed_file(Path(p)))
    return _dedup_preserve_order(seeds)


def _dedup_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="aws-reference-agent")
    sub = p.add_subparsers(dest="command", required=True)

    enrich = sub.add_parser(
        "enrich", help="Enrich concepts from a source into an OKF bundle."
    )
    enrich.add_argument("--source", choices=_SOURCES, required=True)
    enrich.add_argument(
        "--database",
        help="Glue database name (for --source glue).",
    )
    enrich.add_argument(
        "--region",
        help="AWS region for Glue/Athena calls; defaults to the "
        "boto3/AWS config default.",
    )
    enrich.add_argument(
        "--profile",
        help="AWS named profile to use; defaults to the default credential chain.",
    )
    enrich.add_argument(
        "--athena-workgroup",
        default="primary",
        help="Athena workgroup for row sampling (default: primary).",
    )
    enrich.add_argument(
        "--athena-output-location",
        default=None,
        help="s3:// URI for Athena query results; defaults to the "
        "workgroup's configured output location.",
    )
    enrich.add_argument(
        "--no-sample",
        action="store_true",
        help="Skip Athena row sampling.",
    )
    enrich.add_argument(
        "--out", required=True, type=Path, help="Bundle root directory."
    )
    enrich.add_argument(
        "--concept",
        action="append",
        default=None,
        help="Enrich only this concept id (e.g. 'tables/trips'). "
        "Repeatable.",
    )
    enrich.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Claude model alias or id, e.g. sonnet, opus, or a Bedrock "
        f"inference profile id (default: {DEFAULT_MODEL}).",
    )
    enrich.add_argument(
        "--web-seed",
        action="append",
        default=None,
        help="Seed URL for the web pass. Repeatable.",
    )
    enrich.add_argument(
        "--web-seed-file",
        action="append",
        default=None,
        help="Path to a file with one seed URL per line (# comments allowed). "
        "Repeatable.",
    )
    enrich.add_argument(
        "--web-max-pages",
        type=int,
        default=100,
        help="Hard cap on pages the web agent may fetch in one run (default 100).",
    )
    enrich.add_argument(
        "--web-allowed-host",
        action="append",
        default=None,
        help="Extra hostname the web agent may fetch beyond seed hostnames. "
        "Repeatable. Default: only seed hosts.",
    )
    enrich.add_argument(
        "--web-allowed-path-prefix",
        action="append",
        default=None,
        help="Only fetch URLs whose path starts with one of these prefixes "
        "(e.g. '/docs/'). Repeatable. Default: no path restriction.",
    )
    enrich.add_argument(
        "--web-denied-path-substring",
        action="append",
        default=None,
        help="Reject URLs whose path contains any of these substrings "
        "(e.g. '/login', '/pricing'). Repeatable.",
    )
    enrich.add_argument(
        "--web-max-depth",
        type=int,
        default=2,
        help="Hard cap on hop distance from any seed URL (default 2). "
        "Seeds are depth 0; their outbound links are depth 1; etc.",
    )
    enrich.add_argument(
        "--no-web",
        action="store_true",
        help="Skip the web pass entirely.",
    )
    enrich.add_argument(
        "--docs-root",
        type=Path,
        default=None,
        help="Directory of local markdown/text documents to ingest. Enables "
        "the docs pass. Needs no IAM and no network.",
    )
    enrich.add_argument(
        "--docs-include",
        action="append",
        default=None,
        help="Only consider documents whose root-relative path matches one of "
        "these globs (e.g. '*.md'). Repeatable. Default: all text files.",
    )
    enrich.add_argument(
        "--docs-exclude",
        action="append",
        default=None,
        help="Skip documents whose root-relative path matches one of these "
        "globs (applied after --docs-include). Repeatable.",
    )
    enrich.add_argument(
        "--docs-max-files",
        type=int,
        default=200,
        help="Hard cap on documents the docs agent may read in one run "
        "(default 200).",
    )
    enrich.add_argument(
        "--docs-max-bytes",
        type=int,
        default=40 * 1024,
        help="Per-document byte cap; longer documents are truncated "
        "(default 40960).",
    )
    enrich.add_argument(
        "--no-docs",
        action="store_true",
        help="Skip the docs pass entirely, even if --docs-root is given.",
    )
    enrich.add_argument(
        "--verify-queries",
        choices=VERIFY_MODES,
        default="schema",
        dest="verify_queries",
        help=(
            "Query-pattern verification level: "
            "'off' = no checking; "
            "'schema' = local check that query-pattern columns exist in # Schema "
            "(free, no AWS calls, default); "
            "'execute' = also run each snippet against Athena with a small LIMIT "
            "(costs AWS query executions, requires credentials)."
        ),
    )
    enrich.add_argument("-v", "--verbose", action="store_true")

    viz = sub.add_parser(
        "visualize",
        help="Generate a self-contained HTML graph view of an OKF bundle.",
    )
    viz.add_argument(
        "--bundle", required=True, type=Path,
        help="Path to the bundle root directory.",
    )
    viz.add_argument(
        "--out", type=Path, default=None,
        help="Output HTML path (default: <bundle>/viz.html).",
    )
    viz.add_argument(
        "--name", default=None,
        help="Display name for the bundle (default: bundle directory name).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(message)s",
    )
    if getattr(args, "verbose", False):
        logging.getLogger("aws_reference_agent").setLevel(logging.DEBUG)
    # Quiet chatty third-party loggers regardless of mode.
    for noisy in ("boto3", "botocore", "claude_agent_sdk", "urllib3", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if args.command == "visualize":
        from aws_reference_agent.viewer import generate_visualization
        out = args.out or (args.bundle / "viz.html")
        stats = generate_visualization(args.bundle, out, bundle_name=args.name)
        print(
            f"Wrote {stats['concepts']} concept(s), "
            f"{stats['edges']} edge(s), "
            f"{stats['bytes']} bytes → {out}",
            file=sys.stderr,
        )
        return 0

    if args.command == "enrich":
        # Execute-mode verification runs through the Athena sampler, which
        # --no-sample disables. Fail rather than silently verify nothing.
        if args.no_sample and args.verify_queries == VerifyMode.EXECUTE:
            raise SystemExit(
                "--no-sample disables Athena, which --verify-queries execute "
                "requires. Drop --no-sample, or use --verify-queries schema."
            )
        source = _build_source(args.source, args)
        seeds = _collect_seeds(args)
        allowed_hosts: set[str] | None = None
        if seeds:
            allowed_hosts = {urlparse(s).netloc for s in seeds if urlparse(s).netloc}
            if args.web_allowed_host:
                allowed_hosts |= set(args.web_allowed_host)
        docs_root = None if args.no_docs else args.docs_root
        if docs_root is not None and not docs_root.is_dir():
            raise SystemExit(f"--docs-root is not an existing directory: {docs_root}")
        runner = ReferenceRunner(
            source=source,
            bundle_root=args.out,
            model=args.model,
            web_seeds=seeds or None,
            web_max_pages=args.web_max_pages,
            web_allowed_hosts=allowed_hosts,
            web_allowed_path_prefixes=args.web_allowed_path_prefix,
            web_denied_path_substrings=args.web_denied_path_substring,
            web_max_depth=args.web_max_depth,
            docs_root=docs_root,
            docs_include=args.docs_include,
            docs_exclude=args.docs_exclude,
            docs_max_files=args.docs_max_files,
            docs_max_bytes=args.docs_max_bytes,
            verbose=args.verbose,
            verify_queries=args.verify_queries,
        )
        only = (
            [parse_concept_id(c) for c in args.concept] if args.concept else None
        )
        n = runner.enrich_all(only=only)
        web_note = f"; web pass used {len(seeds)} seed(s)" if seeds else "; web pass skipped"
        docs_note = (
            f"; docs pass read up to {args.docs_max_files} file(s) from {docs_root}"
            if docs_root
            else "; docs pass skipped"
        )
        print(
            f"Enriched {n} concept(s) into {args.out}{web_note}{docs_note}",
            file=sys.stderr,
        )
        return 0
    return 1
