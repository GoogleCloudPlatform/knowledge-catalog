"""MiniMax provider wiring for the reference agent.

The reference agent defaults to Gemini: `model` is a plain string that
`google.adk.Agent` and `google.genai` route to Gemini. This module adds a
second provider, MiniMax, without disturbing that default. When `model` names
a MiniMax model, `build_model()` returns a `LiteLlm` instance pointed at a
MiniMax chat-completions endpoint; for every other name it returns the string
unchanged, so existing Gemini invocations behave exactly as before.

MiniMax serves the same models from two regional endpoints -- a global endpoint
(`api.minimax.io`) and a China endpoint (`api.minimaxi.com`) -- selected with
the `KC_MINIMAX_REGION` environment variable (default: `global_en`). The API
key is read from `MINIMAX_API_KEY`. Only the LLM backend changes; BigQuery and
the web tools are untouched.

Heavy dependencies (`google.adk`, `litellm`) are imported lazily inside the
builder functions so importing this module -- and the pure lookup helpers below
-- never requires them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

PROVIDER_NAME = "MiniMax"

_API_KEY_ENV = "MINIMAX_API_KEY"
_REGION_ENV = "KC_MINIMAX_REGION"
DEFAULT_REGION = "global_en"


@dataclass(frozen=True)
class Pricing:
    """USD per million tokens. `None` means the model omits that tier."""

    input: float
    output: float
    cache_read: float | None = None
    cache_write: float | None = None


@dataclass(frozen=True)
class ModelSpec:
    model_id: str
    context_window: int
    pricing: Pricing
    input_modalities: tuple[str, ...]
    thinking: tuple[str, ...]


@dataclass(frozen=True)
class RegionConfig:
    region: str
    openai_base_url: str
    anthropic_base_url: str
    docs_root: str


_MODELS: dict[str, ModelSpec] = {
    "MiniMax-M3": ModelSpec(
        model_id="MiniMax-M3",
        context_window=1_000_000,
        pricing=Pricing(input=0.6, output=2.4, cache_read=0.12, cache_write=None),
        input_modalities=("text", "image", "video"),
        thinking=("adaptive", "disabled"),
    ),
    "MiniMax-M2.7": ModelSpec(
        model_id="MiniMax-M2.7",
        context_window=204_800,
        pricing=Pricing(input=0.3, output=1.2, cache_read=0.06, cache_write=0.375),
        input_modalities=("text",),
        thinking=("always_on",),
    ),
}

_REGIONS: dict[str, RegionConfig] = {
    "global_en": RegionConfig(
        region="global_en",
        openai_base_url="https://api.minimax.io/v1",
        anthropic_base_url="https://api.minimax.io/anthropic",
        docs_root="https://platform.minimax.io/docs",
    ),
    "cn_zh": RegionConfig(
        region="cn_zh",
        openai_base_url="https://api.minimaxi.com/v1",
        anthropic_base_url="https://api.minimaxi.com/anthropic",
        docs_root="https://platform.minimaxi.com/docs",
    ),
}

# Case-insensitive lookup from a user-supplied name to the canonical model id.
_CANONICAL = {mid.lower(): mid for mid in _MODELS}


def known_models() -> tuple[str, ...]:
    """Canonical MiniMax model ids this provider serves."""
    return tuple(_MODELS)


def known_regions() -> tuple[str, ...]:
    return tuple(_REGIONS)


def is_minimax_model(model: str) -> bool:
    """True when `model` names a MiniMax model (case-insensitive)."""
    return bool(model) and model.strip().lower() in _CANONICAL


def canonical_model_id(model: str) -> str:
    try:
        return _CANONICAL[model.strip().lower()]
    except (AttributeError, KeyError):
        raise ValueError(f"Unknown MiniMax model: {model!r}")


def get_model_spec(model: str) -> ModelSpec:
    return _MODELS[canonical_model_id(model)]


def resolve_region(region: str | None = None) -> RegionConfig:
    """Pick a MiniMax regional endpoint.

    `region=None` reads `KC_MINIMAX_REGION` (default `global_en`). An unknown
    region name is a hard error rather than a silent fallback.
    """
    name = (region or os.environ.get(_REGION_ENV) or DEFAULT_REGION).strip()
    try:
        return _REGIONS[name]
    except KeyError:
        raise ValueError(
            f"Unknown MiniMax region {name!r}; expected one of "
            f"{', '.join(sorted(_REGIONS))}."
        )


def litellm_model_name(model: str) -> str:
    """LiteLLM provider route for a MiniMax model on its chat endpoint."""
    return f"openai/{canonical_model_id(model)}"


def build_model(model: str, *, region: str | None = None):
    """Return an ADK model for `model`.

    MiniMax models become a `LiteLlm` instance bound to the selected regional
    endpoint; any other name is returned unchanged so Gemini stays the default.
    """
    if not is_minimax_model(model):
        return model
    from google.adk.models.lite_llm import LiteLlm  # lazy: only for MiniMax

    endpoint = resolve_region(region)
    return LiteLlm(
        model=litellm_model_name(model),
        api_base=endpoint.openai_base_url,
        api_key=os.environ.get(_API_KEY_ENV),
    )


def generate_text(model: str, prompt: str, *, region: str | None = None) -> str:
    """One-shot text completion for a MiniMax model via its chat-completions endpoint.

    Mirrors the Gemini `genai` path used by the index synthesizer, letting a
    MiniMax run produce directory descriptions without a Gemini client.
    """
    import litellm  # lazy: only for MiniMax

    endpoint = resolve_region(region)
    response = litellm.completion(
        model=litellm_model_name(model),
        messages=[{"role": "user", "content": prompt}],
        api_base=endpoint.openai_base_url,
        api_key=os.environ.get(_API_KEY_ENV),
    )
    return (response.choices[0].message.content or "").strip()
