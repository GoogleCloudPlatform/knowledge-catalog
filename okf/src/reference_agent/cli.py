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
from reference_agent.sources.localfile import LocalFileSource

_SOURCES = ("bq", "localfile", "api")


def _build_source(name: str, args: argparse.Namespace):
    if name == "bq":
        if not args.dataset:
            raise SystemExit("--dataset is required for --source bq")
        return BigQuerySource(
            dataset=args.dataset, billing_project=args.billing_project
        )
    if name == "localfile":
        if not args.local_path:
            raise SystemExit("--local-path is required for --source localfile")
        return LocalFileSource(
            path=args.local_path,
            pattern=args.local_pattern or "**/*",
            recursive=not args.local_no_recursive,
        )
    if name == "api":
        from reference_agent.sources.api_source import ApiSource
        return ApiSource(
            urls=getattr(args, "api_urls", None),
            api_endpoint=getattr(args, "api_endpoint", None),
            api_url_field=getattr(args, "api_url_field", "url") or "url",
            url_file=getattr(args, "api_url_file", None),
            auth_token=getattr(args, "api_token", None),
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
        "--local-path",
        help="Local directory path (for --source localfile).",
    )
    enrich.add_argument(
        "--local-pattern",
        default="**/*",
        help="File glob pattern for localfile source (default: **/*).",
    )
    enrich.add_argument(
        "--local-no-recursive",
        action="store_true",
        help="Disable recursive directory scan for localfile source.",
    )
    # API source parameters
    enrich.add_argument(
        "--api-url", action="append", default=None, dest="api_urls",
        help="File URL to fetch (for --source api). Repeatable.",
    )
    enrich.add_argument(
        "--api-endpoint", default=None,
        help="API endpoint returning JSON file list (for --source api).",
    )
    enrich.add_argument(
        "--api-url-field", default="url",
        help="JSON field name for file URL in API response (default: url).",
    )
    enrich.add_argument(
        "--api-url-file", default=None,
        help="Path to a text file with one URL per line (for --source api).",
    )
    enrich.add_argument(
        "--api-token", default=None,
        help="Bearer token for API auth (or set API_AUTH_TOKEN env).",
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

    # Shortcut subcommand: localfile
    # Equivalent to `enrich --source localfile --no-web`, but with positional
    # path argument and sensible defaults for local-file workflows.
    lf = sub.add_parser(
        "localfile",
        help="Shortcut: enrich OKF bundle from local files (no web pass).",
    )
    lf.add_argument(
        "path",
        type=Path,
        nargs="?",
        default=Path("."),
        help="Local directory to scan (default: current directory).",
    )
    lf.add_argument(
        "--pattern",
        default="**/*",
        help="File glob pattern (default: **/*). Examples: '**/*.pdf', '**/*.{md,txt}'.",
    )
    lf.add_argument(
        "-o", "--out",
        type=Path,
        default=Path("./okf-bundle"),
        help="Bundle root directory (default: ./okf-bundle).",
    )
    lf.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"LLM model id (default: {DEFAULT_MODEL}). "
        "Supports: gemini-flash-latest, claude-sonnet-4, openai/gpt-4o, "
        "deepseek/deepseek-chat, ollama/qwen2.5:7b. "
        "Use 'reference-agent list-models' to see all presets.",
    )
    lf.add_argument(
        "--no-recursive",
        action="store_true",
        help="Disable recursive directory scan.",
    )
    lf.add_argument(
        "--api-url", action="append", default=None, dest="api_urls",
        help="Also fetch file(s) from this URL. Repeatable. "
        "Mixes remote URLs with local files.",
    )
    lf.add_argument(
        "--api-token", default=None,
        help="Bearer token for remote URL auth (or set API_AUTH_TOKEN env).",
    )
    lf.add_argument(
        "--concept",
        action="append",
        default=None,
        help="Enrich only this concept id (e.g. 'tables/events_'). Repeatable.",
    )
    lf.add_argument("-v", "--verbose", action="store_true")

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

    sub.add_parser(
        "list-models",
        help="List supported LLM model presets.",
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

    if args.command == "list-models":
        from reference_agent.llm_support import list_supported_models
        print(list_supported_models())
        return 0

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

    if args.command == "localfile":
        # Shortcut path: local files only, no web pass, sensible defaults.
        # If --api-url is given, mix remote files via a composite source.
        api_urls = getattr(args, "api_urls", None)
        if api_urls:
            from reference_agent.sources.api_source import ApiSource
            api_src = ApiSource(
                urls=api_urls,
                auth_token=getattr(args, "api_token", None),
            )
            # Composite: combine local + remote concepts
            local_src = LocalFileSource(
                path=str(args.path),
                pattern=args.pattern,
                recursive=not args.no_recursive,
            )
            api_src.list_concepts()  # trigger download
            local_src.list_concepts()
            # Merge: create a simple wrapper
            from reference_agent.sources.base import Source as _Source
            class _CompositeSource(_Source):
                name = "composite"
                def list_concepts(self):
                    return local_src.list_concepts() + api_src.list_concepts()
                def read_concept(self, ref):
                    for src in (local_src, api_src):
                        found = src.find(ref.id)
                        if found:
                            return src.read_concept(found)
                    raise ValueError(f"Unknown concept: {ref.id_str}")
                def sample_rows(self, ref, n=5):
                    for src in (local_src, api_src):
                        found = src.find(ref.id)
                        if found:
                            return src.sample_rows(found, n)
                    return None
            source = _CompositeSource()
        else:
            source = LocalFileSource(
                path=str(args.path),
                pattern=args.pattern,
                recursive=not args.no_recursive,
            )
        # Check model environment variables before running
        from reference_agent.llm_support import check_model_env, get_model_help
        missing = check_model_env(args.model)
        if missing:
            print(f"Warning: missing env vars for {args.model}: {', '.join(missing)}",
                  file=sys.stderr)
            print(get_model_help(args.model), file=sys.stderr)
        runner = ReferenceRunner(
            source=source,
            bundle_root=args.out,
            model=args.model,
            web_seeds=None,
            verbose=args.verbose,
        )
        only = (
            [parse_concept_id(c) for c in args.concept] if args.concept else None
        )
        n = runner.enrich_all(only=only)
        print(
            f"Enriched {n} concept(s) from {args.path} into {args.out} (web pass skipped)",
            file=sys.stderr,
        )
        return 0
    return 1
