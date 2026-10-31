from __future__ import annotations

import pytest

from reference_agent import providers


def test_known_models_are_the_two_current_ids():
    assert providers.known_models() == ("MiniMax-M3", "MiniMax-M2.7")


@pytest.mark.parametrize(
    "name",
    ["MiniMax-M3", "minimax-m3", "  MiniMax-M2.7  ", "MINIMAX-M2.7"],
)
def test_is_minimax_model_matches_case_insensitively(name):
    assert providers.is_minimax_model(name)


@pytest.mark.parametrize("name", ["gemini-flash-latest", "", "gpt-4o", "minimax"])
def test_non_minimax_names_are_rejected(name):
    assert not providers.is_minimax_model(name)


def test_canonical_id_normalizes_case_and_whitespace():
    assert providers.canonical_model_id(" minimax-m3 ") == "MiniMax-M3"
    with pytest.raises(ValueError):
        providers.canonical_model_id("gemini-flash-latest")


def test_m3_spec_matches_registry():
    spec = providers.get_model_spec("MiniMax-M3")
    assert spec.context_window == 1_000_000
    assert spec.pricing.input == 0.6
    assert spec.pricing.output == 2.4
    assert spec.pricing.cache_read == 0.12
    assert spec.pricing.cache_write is None
    assert spec.input_modalities == ("text", "image", "video")
    assert spec.thinking == ("adaptive", "disabled")


def test_m27_spec_matches_registry():
    spec = providers.get_model_spec("MiniMax-M2.7")
    assert spec.context_window == 204_800
    assert spec.pricing.input == 0.3
    assert spec.pricing.output == 1.2
    assert spec.pricing.cache_read == 0.06
    assert spec.pricing.cache_write == 0.375
    assert spec.input_modalities == ("text",)
    assert spec.thinking == ("always_on",)


def test_default_region_is_global_endpoint():
    region = providers.resolve_region()
    assert region.region == "global_en"
    assert region.openai_base_url == "https://api.minimax.io/v1"
    assert region.anthropic_base_url == "https://api.minimax.io/anthropic"
    assert region.docs_root == "https://platform.minimax.io/docs"


def test_china_region_endpoint():
    region = providers.resolve_region("cn_zh")
    assert region.openai_base_url == "https://api.minimaxi.com/v1"
    assert region.anthropic_base_url == "https://api.minimaxi.com/anthropic"
    assert region.docs_root == "https://platform.minimaxi.com/docs"


def test_region_env_override(monkeypatch):
    monkeypatch.setenv("KC_MINIMAX_REGION", "cn_zh")
    assert providers.resolve_region().region == "cn_zh"


def test_unknown_region_is_rejected():
    with pytest.raises(ValueError):
        providers.resolve_region("eu_de")


def test_litellm_model_name_uses_openai_route():
    assert providers.litellm_model_name("minimax-m3") == "openai/MiniMax-M3"
    assert providers.litellm_model_name("MiniMax-M2.7") == "openai/MiniMax-M2.7"


def test_build_model_passes_through_non_minimax():
    assert providers.build_model("gemini-flash-latest") == "gemini-flash-latest"
