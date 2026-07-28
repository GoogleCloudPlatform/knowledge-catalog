from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from urllib.parse import urlparse

from reference_agent.agent import DEFAULT_MODEL
from reference_agent.bundle.paths import parse_concept_id
from reference_agent.runner import ReferenceRunner
from reference_agent.sources.bigquery import BigQuerySource

_SOURCES = ("bq",)


def _build_source(name: str, args: argparse.Namespace):
    if name == "bq":
        if not args.dataset:
            raise SystemExit("--dataset is required for --source bq")
        return BigQuerySource(
            dataset=args.dataset, billing_project=args.billing_project
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
    p = argparse.ArgumentParser(prog="reference-agent")
    sub = p.add_subparsers(dest="command", required=True)

    enrich = sub.add_parser(
        "enrich", help="Enrich concepts from a source into an OKF bundle."
    )
    enrich.add_argument("--source", choices=_SOURCES, required=True)
    enrich.add_argument(
        "--dataset",
        help="Source-specific identifier (for --source bq: 'project.dataset').",
    )
    enrich.add_argument(
        "--billing-project",
        help="Google Cloud project to bill for queries; "
        "defaults to ADC default.",
    )
    enrich.add_argument(
        "--out", required=True, type=Path, help="Bundle root directory."
    )
    enrich.add_argument(
        "--concept",
        action="append",
        default=None,
        help="Enrich only this concept id (e.g. 'tables/events_'). "
        "Repeatable.",
    )
    enrich.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Gemini model id (default: {DEFAULT_MODEL}).",
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
        logging.getLogger("reference_agent").setLevel(logging.DEBUG)
    # Quiet chatty third-party loggers regardless of mode.
    for noisy in ("google", "google_genai", "google_adk", "urllib3", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if args.command == "visualize":
        from reference_agent.viewer import generate_visualization
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
        source = _build_source(args.source, args)
        seeds = _collect_seeds(args)
        allowed_hosts: set[str] | None = None
        if seeds:
            allowed_hosts = {urlparse(s).netloc for s in seeds if urlparse(s).netloc}
            if args.web_allowed_host:
                allowed_hosts |= set(args.web_allowed_host)
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
            verbose=args.verbose,
        )
        only = (
            [parse_concept_id(c) for c in args.concept] if args.concept else None
        )
        n = runner.enrich_all(only=only)
        web_note = f"; web pass used {len(seeds)} seed(s)" if seeds else "; web pass skipped"
        print(f"Enriched {n} concept(s) into {args.out}{web_note}", file=sys.stderr)
        return 0
    return 1
