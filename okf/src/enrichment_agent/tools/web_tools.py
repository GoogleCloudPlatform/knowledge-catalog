from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from enrichment_agent.tools.context import get_web_state
from enrichment_agent.web.fetcher import FetchError, fetch_and_parse


def fetch_url(url: str) -> dict[str, Any]:
    """Fetch a single web page and return its content as markdown plus its
    outbound links.

    The session-wide crawl budget (`max_pages`), the allowed-hosts filter,
    optional URL path-prefix allow-list, denied-substring blocklist, and a
    hop-depth cap measured from the seed URLs are all enforced inside this
    tool. When a fetch is rejected the return value contains an `error`
    field instead of page content. Treat that as a signal to stop or pick a
    different URL; do not retry the same URL.

    Successful return shape:
      {"url", "title", "markdown", "links",
       "fetched_count", "max_pages_budget", "depth", "max_depth"}

    Rejected return shape:
      {"error": "<reason>", "url": url,
       "fetched_count", "max_pages_budget"}
    """
    state = get_web_state()
    parsed = urlparse(url)

    def _reject(reason: str) -> dict[str, Any]:
        return {
            "error": reason,
            "url": url,
            "fetched_count": state.fetched_count,
            "max_pages_budget": state.max_pages,
        }

    if parsed.scheme not in ("http", "https"):
        return _reject(f"unsupported scheme: {parsed.scheme or '(none)'}")
    if not parsed.netloc:
        return _reject("missing host in URL")
    if state.allowed_hosts and parsed.netloc not in state.allowed_hosts:
        return _reject(
            f"host not in allowed list: {parsed.netloc} "
            f"(allowed: {sorted(state.allowed_hosts)})"
        )
    path = parsed.path or "/"
    if state.allowed_path_prefixes and not any(
        path.startswith(p) for p in state.allowed_path_prefixes
    ):
        return _reject(
            f"path not in allowed prefixes: {path} "
            f"(allowed: {list(state.allowed_path_prefixes)})"
        )
    for bad in state.denied_path_substrings:
        if bad and bad in path:
            return _reject(f"path matches denied substring: {bad!r}")
    if url in state.visited:
        return _reject("already fetched in this session")
    if state.fetched_count >= state.max_pages:
        return _reject("max_pages reached")

    depth = state.url_depth.get(url)
    if depth is None:
        # Unknown URL — treat as the agent typing it in directly, which is
        # only allowed for the initial seeds (already pre-registered at
        # depth 0). Anything else means the agent invented a URL not
        # surfaced via a parent page; reject so we don't lose depth tracking.
        return _reject(
            "URL not reachable from a seed within the crawl graph "
            "(was not returned as a link by any fetched page)"
        )
    if depth > state.max_depth:
        return _reject(
            f"depth {depth} exceeds max_depth {state.max_depth}"
        )

    state.visited.add(url)
    state.fetched_count += 1

    try:
        page = fetch_and_parse(url)
    except FetchError as e:
        return _reject(f"fetch failed: {e}")

    child_depth = depth + 1
    for link in page.links:
        state.url_depth.setdefault(link, child_depth)

    return {
        "url": page.url,
        "title": page.title,
        "markdown": page.markdown,
        "links": page.links,
        "fetched_count": state.fetched_count,
        "max_pages_budget": state.max_pages,
        "depth": depth,
        "max_depth": state.max_depth,
    }
