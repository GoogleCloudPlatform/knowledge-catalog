from __future__ import annotations

from unittest.mock import patch

import pytest

from reference_agent.tools.context import clear_web_state, set_web_state
from reference_agent.tools.web_tools import fetch_url
from reference_agent.web.fetcher import Page


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_web_state()


def _set_state(**overrides):
    defaults = dict(
        allowed_hosts={"docs.example.com"},
        max_pages=10,
        seeds=["https://docs.example.com/docs/intro"],
        allowed_path_prefixes=None,
        denied_path_substrings=None,
        max_depth=2,
    )
    defaults.update(overrides)
    set_web_state(**defaults)


def _page(url: str, links: list[str] | None = None) -> Page:
    return Page(url=url, title="t", markdown="m", links=list(links or []))


def test_seed_fetch_succeeds_and_records_link_depth():
    _set_state()
    with patch(
        "reference_agent.tools.web_tools.fetch_and_parse",
        return_value=_page(
            "https://docs.example.com/docs/intro",
            links=["https://docs.example.com/docs/next"],
        ),
    ):
        result = fetch_url("https://docs.example.com/docs/intro")
    assert "error" not in result
    assert result["depth"] == 0
    # The followed link is now reachable at depth 1.
    from reference_agent.tools.context import get_web_state
    assert get_web_state().url_depth["https://docs.example.com/docs/next"] == 1


def test_allowed_path_prefix_rejects_off_path_urls():
    _set_state(
        seeds=["https://docs.example.com/docs/intro"],
        allowed_path_prefixes=["/docs/"],
    )
    with patch(
        "reference_agent.tools.web_tools.fetch_and_parse",
        return_value=_page(
            "https://docs.example.com/docs/intro",
            links=["https://docs.example.com/blog/post"],
        ),
    ):
        fetch_url("https://docs.example.com/docs/intro")
    result = fetch_url("https://docs.example.com/blog/post")
    assert "error" in result
    assert "allowed prefixes" in result["error"]


def test_denied_path_substring_rejects():
    _set_state(
        seeds=["https://docs.example.com/docs/intro"],
        denied_path_substrings=["/login"],
    )
    with patch(
        "reference_agent.tools.web_tools.fetch_and_parse",
        return_value=_page(
            "https://docs.example.com/docs/intro",
            links=["https://docs.example.com/login"],
        ),
    ):
        fetch_url("https://docs.example.com/docs/intro")
    result = fetch_url("https://docs.example.com/login")
    assert "error" in result
    assert "denied substring" in result["error"]


def test_max_depth_caps_recursion():
    _set_state(
        seeds=["https://docs.example.com/a"],
        max_depth=1,
    )
    with patch(
        "reference_agent.tools.web_tools.fetch_and_parse",
        side_effect=[
            _page("https://docs.example.com/a", links=["https://docs.example.com/b"]),
            _page("https://docs.example.com/b", links=["https://docs.example.com/c"]),
        ],
    ):
        # depth 0 (seed): ok
        r0 = fetch_url("https://docs.example.com/a")
        assert "error" not in r0
        # depth 1: ok (== max_depth)
        r1 = fetch_url("https://docs.example.com/b")
        assert "error" not in r1
        # depth 2: rejected (> max_depth=1)
        r2 = fetch_url("https://docs.example.com/c")
    assert "error" in r2
    assert "exceeds max_depth" in r2["error"]


def test_unregistered_url_rejected():
    _set_state(seeds=["https://docs.example.com/docs/intro"])
    # Agent invents a URL that was never returned as a link.
    result = fetch_url("https://docs.example.com/docs/random")
    assert "error" in result
    assert "not reachable from a seed" in result["error"]
