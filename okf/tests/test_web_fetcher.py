from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from reference_agent.web.fetcher import FetchError, fetch_and_parse


def _mock_response(body: bytes, content_type: str = "text/html; charset=utf-8", url: str = "https://example.com/page"):
    resp = MagicMock()
    resp.headers = {"Content-Type": content_type}
    resp.read.return_value = body
    resp.geturl.return_value = url
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    return resp


def test_fetch_and_parse_extracts_title_links_markdown():
    html = b"""
    <html><head><title>  Hello   World  </title></head>
    <body>
      <h1>Heading</h1>
      <p>Some <strong>bold</strong> text and a <a href="/relative">link</a>.</p>
      <a href="https://example.com/page2">absolute</a>
      <a href="https://other.example.com/x">offsite</a>
      <a href="mailto:foo@example.com">skip me</a>
      <a href="javascript:void(0)">also skip</a>
    </body></html>
    """
    with patch("reference_agent.web.fetcher.urlopen") as urlopen:
        urlopen.return_value = _mock_response(html)
        page = fetch_and_parse("https://example.com/page")

    assert page.title == "Hello World"
    assert "Heading" in page.markdown
    assert "bold" in page.markdown
    assert "https://example.com/relative" in page.links
    assert "https://example.com/page2" in page.links
    assert "https://other.example.com/x" in page.links
    assert not any(l.startswith("mailto:") for l in page.links)
    assert not any(l.startswith("javascript:") for l in page.links)


def test_fetch_and_parse_rejects_non_html():
    with patch("reference_agent.web.fetcher.urlopen") as urlopen:
        urlopen.return_value = _mock_response(b"{}", content_type="application/json")
        with pytest.raises(FetchError):
            fetch_and_parse("https://example.com/data.json")


def test_fetch_and_parse_truncates_large_pages():
    big_text = "<p>" + ("x" * 200_000) + "</p>"
    html = f"<html><head><title>big</title></head><body>{big_text}</body></html>".encode()
    with patch("reference_agent.web.fetcher.urlopen") as urlopen:
        urlopen.return_value = _mock_response(html)
        page = fetch_and_parse("https://example.com/big")

    assert len(page.markdown.encode("utf-8")) <= 40 * 1024 + 100
    assert "[...truncated...]" in page.markdown


def test_fetch_and_parse_wraps_network_errors():
    with patch("reference_agent.web.fetcher.urlopen") as urlopen:
        urlopen.side_effect = OSError("connection refused")
        with pytest.raises(FetchError) as exc:
            fetch_and_parse("https://example.com/dead")
        assert "connection refused" in str(exc.value)
