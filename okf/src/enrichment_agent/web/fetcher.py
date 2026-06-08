from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.request import Request, urlopen

from markdownify import markdownify

_USER_AGENT = "okf-enrichment-agent/0.1 (+https://github.com/amirhormati/open-knowledge-format)"
_MAX_MARKDOWN_BYTES = 40 * 1024

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_HREF_RE = re.compile(r"""href\s*=\s*["']([^"'#\s]+)["']""", re.IGNORECASE)


class FetchError(Exception):
    pass


@dataclass(frozen=True)
class Page:
    url: str
    title: str | None
    markdown: str
    links: list[str]


def _extract_title(html: str) -> str | None:
    m = _TITLE_RE.search(html)
    if not m:
        return None
    raw = re.sub(r"\s+", " ", m.group(1)).strip()
    return raw or None


def _extract_links(html: str, base_url: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for match in _HREF_RE.finditer(html):
        href = match.group(1).strip()
        if not href:
            continue
        scheme = urlparse(href).scheme.lower()
        if scheme and scheme not in ("http", "https", ""):
            continue
        absolute, _ = urldefrag(urljoin(base_url, href))
        if absolute in seen:
            continue
        seen.add(absolute)
        out.append(absolute)
    return out


def _truncate(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max_bytes].decode("utf-8", errors="ignore") + "\n\n[...truncated...]"


def fetch_and_parse(url: str, *, timeout: float = 10.0) -> Page:
    req = Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "text/html,*/*;q=0.5"})
    try:
        with urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("Content-Type", "")
            final_url = resp.geturl() or url
            body_bytes = resp.read()
    except Exception as e:
        raise FetchError(str(e)) from e

    if "html" not in content_type.lower():
        raise FetchError(f"non-HTML content-type: {content_type or 'unknown'}")

    charset = "utf-8"
    if "charset=" in content_type.lower():
        charset = content_type.lower().split("charset=", 1)[1].split(";", 1)[0].strip() or "utf-8"
    try:
        html = body_bytes.decode(charset, errors="replace")
    except LookupError:
        html = body_bytes.decode("utf-8", errors="replace")

    title = _extract_title(html)
    links = _extract_links(html, final_url)
    markdown = markdownify(html, heading_style="ATX")
    markdown = _truncate(markdown, _MAX_MARKDOWN_BYTES)

    return Page(url=final_url, title=title, markdown=markdown, links=links)
