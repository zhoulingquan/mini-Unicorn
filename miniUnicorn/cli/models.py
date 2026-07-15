"""Model information helpers for the onboard wizard.

This module provides a built-in model metadata table (Trae-style) covering
mainstream LLM providers, so the agent loop can automatically detect each
model's context window size without requiring user input.

The lookup uses fuzzy name matching so model variants like
``"gpt-4o-2024-05-13"``, ``"deepseek/deepseek-chat"`` and
``"claude-3-5-sonnet-20241022"`` all resolve to their family's context limit.
"""

from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------------------
# Built-in model -> context limit mapping table (tokens).
#
# Keys are lowercase, date-suffix-stripped family identifiers ordered so that
# longer/more-specific patterns are checked first. Values are the model's
# maximum context window in tokens. The fallback default is 65_536.
# ---------------------------------------------------------------------------
_MODEL_CONTEXT_LIMITS: list[tuple[str, int]] = [
    # --- OpenAI -----------------------------------------------------------
    ("gpt-5", 400_000),
    ("o3-mini", 200_000),
    ("o3", 200_000),
    ("o1-mini", 128_000),
    ("o1-preview", 128_000),
    ("o1", 200_000),
    ("gpt-4o-mini", 128_000),
    ("gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("gpt-4-32k", 32_768),
    ("gpt-4", 8_192),
    ("gpt-3.5-turbo-16k", 16_384),
    ("gpt-3.5-turbo", 4_096),
    ("gpt-35-turbo", 4_096),
    # --- Anthropic --------------------------------------------------------
    ("claude-opus-4", 200_000),
    ("claude-sonnet-4", 200_000),
    ("claude-3-7-sonnet", 200_000),
    ("claude-3-5-sonnet", 200_000),
    ("claude-3-5-haiku", 200_000),
    ("claude-3-opus", 200_000),
    ("claude-3-sonnet", 200_000),
    ("claude-3-haiku", 200_000),
    ("claude-2.1", 200_000),
    ("claude-2", 100_000),
    ("claude-instant", 100_000),
    # --- Google Gemini ----------------------------------------------------
    ("gemini-2.5-pro", 1_048_576),
    ("gemini-2.5-flash", 1_048_576),
    ("gemini-2.0-flash", 1_048_576),
    ("gemini-1.5-pro", 2_097_152),
    ("gemini-1.5-flash", 1_048_576),
    ("gemini-1.5-flash-8b", 1_048_576),
    ("gemini-pro", 32_768),
    # --- DeepSeek ---------------------------------------------------------
    ("deepseek-r1", 128_000),
    ("deepseek-v3", 128_000),
    ("deepseek-chat", 128_000),
    ("deepseek-coder", 128_000),
    ("deepseek-reasoner", 128_000),
    ("deepseek", 128_000),
    # --- Zhipu / GLM ------------------------------------------------------
    ("glm-4-plus", 128_000),
    ("glm-4-air", 128_000),
    ("glm-4-flash", 1_000_000),
    ("glm-4-long", 1_000_000),
    ("glm-4v", 128_000),
    ("glm-4", 128_000),
    ("glm-3-turbo", 128_000),
    # --- Moonshot / Kimi --------------------------------------------------
    ("kimi-k2", 256_000),
    ("moonshot-v1-128k", 128_000),
    ("moonshot-v1-32k", 32_768),
    ("moonshot-v1-8k", 8_192),
    ("moonshot-v1", 8_192),
    # --- Qwen / Tongyi ----------------------------------------------------
    ("qwen3-235b", 131_072),
    ("qwen3-32b", 131_072),
    ("qwen3", 131_072),
    ("qwen2.5-coder", 128_000),
    ("qwen2.5", 128_000),
    ("qwen2", 32_768),
    ("qwen-max-longcontext", 32_768),
    ("qwen-max", 32_768),
    ("qwen-plus", 131_072),
    ("qwen-turbo", 1_000_000),
    # --- MiniMax ----------------------------------------------------------
    ("abab6.5s", 245_760),
    ("abab6.5", 245_760),
    ("abab6", 245_760),
    # --- Mistral ----------------------------------------------------------
    ("mistral-large", 128_000),
    ("mistral-medium", 32_768),
    ("mistral-small", 32_768),
    ("mistral-nemo", 128_000),
    ("mixtral-8x22b", 64_000),
    ("mixtral-8x7b", 32_768),
    ("codestral", 32_768),
    # --- Groq / Meta Llama ------------------------------------------------
    ("llama-3.3-70b", 128_000),
    ("llama-3.1-70b", 128_000),
    ("llama-3.1-8b", 128_000),
    ("llama-3.2", 128_000),
    ("llama3-70b", 8_192),
    ("llama3-8b", 8_192),
    # --- Yi / 01.AI -------------------------------------------------------
    ("yi-large", 32_768),
    ("yi-34b", 4_096),
    ("yi-6b", 4_096),
]

# Fallback when a model is not present in the mapping table. Keeps the agent
# loop functional (Trae's approach: built-in metadata + sane default).
DEFAULT_CONTEXT_LIMIT = 65_536

# Patterns to strip from model names before lookup.
_DATE_SUFFIX_RE = re.compile(r"-\d{4}-\d{2}-\d{2}$")
_DATE_SUFFIX_RE2 = re.compile(r"-\d{6,}$")  # e.g. -20241022
_VERSION_SUFFIX_RE = re.compile(r"-v\d+$")  # e.g. -v2
_PROVIDER_PREFIX_RE = re.compile(r"^[a-z][a-z0-9_-]+/", re.IGNORECASE)


def _normalize_model_name(model: str) -> str:
    """Normalize a model id for lookup: strip provider prefix and date/version suffixes.

    Examples:
        "deepseek/deepseek-chat"        -> "deepseek-chat"
        "gpt-4o-2024-05-13"             -> "gpt-4o"
        "claude-3-5-sonnet-20241022"    -> "claude-3-5-sonnet"
        "moonshot-v1-128k"              -> "moonshot-v1-128k"  (k kept, key matches)
    """
    name = (model or "").strip()
    if not name:
        return ""
    # Strip provider prefix like "openai/", "anthropic/", "deepseek/".
    name = _PROVIDER_PREFIX_RE.sub("", name, count=1)
    # Strip full ISO date suffix first, then compact YYYYMMDD suffix.
    name = _DATE_SUFFIX_RE.sub("", name)
    name = _DATE_SUFFIX_RE2.sub("", name)
    name = _VERSION_SUFFIX_RE.sub("", name)
    return name.strip().lower()


def get_all_models() -> list[str]:
    """Return all known model family identifiers (for autocomplete / listing)."""
    return [key for key, _ in _MODEL_CONTEXT_LIMITS]


def find_model_info(model_name: str) -> dict[str, Any] | None:
    """Return basic metadata for *model_name*, or None if unknown."""
    key = _normalize_model_name(model_name)
    if not key:
        return None
    for pattern, limit in _MODEL_CONTEXT_LIMITS:
        if pattern == key or pattern in key:
            return {
                "name": model_name,
                "family": pattern,
                "context_window_tokens": limit,
            }
    return None


def get_model_context_limit(model: str, provider: str = "auto") -> int | None:
    """Return the context window limit (tokens) for *model*.

    Uses fuzzy family matching against a built-in mapping table. Returns the
    default fallback (65_536) when the model is not in the table — this keeps
    the agent loop functional even for unknown models (Trae-style: built-in
    metadata + sane default).

    The *provider* argument is accepted for API compatibility but does not
    affect the lookup, since model names are already provider-disambiguated
    via their prefix (e.g. ``"deepseek/deepseek-chat"``).
    """
    key = _normalize_model_name(model)
    if not key:
        return DEFAULT_CONTEXT_LIMIT
    # Check exact match first, then substring (family) match. The table is
    # ordered longest-first so "gpt-4o-mini" wins over "gpt-4o".
    for pattern, limit in _MODEL_CONTEXT_LIMITS:
        if pattern == key:
            return limit
    for pattern, limit in _MODEL_CONTEXT_LIMITS:
        if pattern in key:
            return limit
    return DEFAULT_CONTEXT_LIMIT


def get_model_suggestions(_partial: str, provider: str = "auto", limit: int = 20) -> list[str]:
    """Return up to *limit* model family names matching *_partial*.

    Currently returns the full list (autocomplete UI is disabled upstream);
    signature preserved for callers.
    """
    partial = _partial.strip().lower()
    if not partial:
        return [k for k, _ in _MODEL_CONTEXT_LIMITS[:limit]]
    matches = [k for k, _ in _MODEL_CONTEXT_LIMITS if partial in k]
    return matches[:limit]


def format_token_count(tokens: int) -> str:
    """Format token count for display (e.g., 200000 -> '200,000')."""
    return f"{tokens:,}"
