"""Model context window detection via Hugging Face search.

This module resolves a model's context window size by:
1. Looking up a permanent learning table
   (``.miniUnicorn-config/cache/model_context_learned.json``) — entries are
   cached forever per normalized model name. When a model is upgraded and
   its name changes, it is treated as a new model and re-queried.
2. Querying the Hugging Face API — first via direct namespace candidates
   (original input + organization hints), then via the HF search API
   (``GET /api/models?search=…``) to discover candidates for models whose
   namespace is unknown. Successful results are persisted to the learning
   table.
3. Falling back to a default (65_536) or raising an error for closed-source
   models that are not on Hugging Face, prompting manual configuration.

The built-in hardcoded model→context table has been removed in favor of
on-demand HF lookups, so new models are supported automatically as soon as
they appear on HF.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

# Fallback when auto-lookup is disabled (env var) or as a final safety net
# for the *_query_hf_context_limit_with_search* error message.
DEFAULT_CONTEXT_LIMIT = 65_536

# ---------------------------------------------------------------------------
# Auto-lookup settings for Hugging Face API + ModelScope fallback + permanent learning table.
# ---------------------------------------------------------------------------
HF_API_BASE = "https://huggingface.co/api/models"
HF_RAW_BASE = "https://huggingface.co"
HF_SEARCH_BASE = "https://huggingface.co/api/models"  # search via ?search=
HF_QUERY_TIMEOUT_S = 6.0
HF_SEARCH_TIMEOUT_S = 8.0
HF_SEARCH_MAX_CANDIDATES = 5

# ModelScope (阿里魔搭) — 国产模型仓库,作为 HF 的 fallback。
# 国内站点,不需要代理;httpx 默认会读取 HTTP_PROXY/HTTPS_PROXY 环境变量,
# 这里在请求时用 trust_env=False 绕过,避免把国内请求走代理。
MODELSCOPE_API_BASE = "https://modelscope.cn/api/v1/models"
MODELSCOPE_RAW_BASE = "https://modelscope.cn/api/v1/models"
MODELSCOPE_QUERY_TIMEOUT_S = 6.0
MODELSCOPE_SEARCH_TIMEOUT_S = 8.0
MODELSCOPE_SEARCH_MAX_CANDIDATES = 5

ENV_NO_AUTO_LOOKUP = "MINIUNICORN_NO_AUTO_LOOKUP"

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
    """Return all known model family identifiers (for autocomplete / listing).

    With the built-in table removed, this always returns an empty list —
    callers should rely on provider ``/v1/models`` endpoints instead.
    """
    return []


def find_model_info(model_name: str) -> dict[str, Any] | None:
    """Return basic metadata for *model_name*, or None if not yet learned.

    Looks up the permanent learning table. Returns None for models that
    have not been seen before (callers should trigger a HF search to populate).
    """
    key = _normalize_model_name(model_name)
    if not key:
        return None
    entry = _load_learned_entry(key)
    if entry is None:
        return None
    return {
        "name": model_name,
        "family": key,
        "context_window_tokens": entry.get("limit"),
        "source": entry.get("source"),
        "hf_model_id": entry.get("hf_model_id"),
    }


def get_model_context_limit(
    model: str,
    provider: str = "auto",
    *,
    raise_on_unknown: bool = False,
) -> int | None:
    """Return the context window limit (tokens) for *model*.

    Resolution order:
    1. Permanent learning table (``model_context_learned.json``) — entries
       are stored forever per normalized model name. A model that is
       upgraded and renamed is treated as a new model and re-queried.
    2. Hugging Face API (direct namespace candidates + search API) —
       successful results are persisted to the learning table.

    When both miss (model not on HF / network error / disabled via
    :data:`ENV_NO_AUTO_LOOKUP`):
    - ``raise_on_unknown=False`` (default): log a warning and return
      :data:`DEFAULT_CONTEXT_LIMIT` (65_536), preserving legacy behavior.
    - ``raise_on_unknown=True``: raise ``RuntimeError`` prompting the user to
      set ``context_window_tokens`` in config.json manually.

    The *provider* argument is accepted for API compatibility but does not
    affect the lookup, since model names are already provider-disambiguated
    via their prefix (e.g. ``"deepseek/deepseek-chat"``).
    """
    if os.environ.get(ENV_NO_AUTO_LOOKUP):
        if raise_on_unknown:
            raise RuntimeError(
                f"自动查询已被环境变量 {ENV_NO_AUTO_LOOKUP} 禁用。"
                f"请在 .miniUnicorn-config/config.json 的 model 段显式设置 "
                f"'context_window_tokens' 字段(如 128000)。"
            )
        return DEFAULT_CONTEXT_LIMIT

    key = _normalize_model_name(model)
    if not key:
        return DEFAULT_CONTEXT_LIMIT

    # 1) Learning table — permanent cache, no TTL.
    learned = _load_learned_limit(key)
    if learned is not None:
        logger.debug("模型 {} 上下文窗口: 使用学习表值 {} tokens", model, learned)
        return learned

    # 2) Hugging Face API + ModelScope fallback.
    try:
        limit, source, hf_model_id = _query_model_context_limit(model, key)
    except Exception as exc:
        if raise_on_unknown:
            raise RuntimeError(
                f"无法自动确定模型 '{model}' 的上下文窗口大小。\n"
                f"  原因: {exc}\n"
                f"  解决方法: 在 .miniUnicorn-config/config.json 的 model 段显式设置 "
                f"'context_window_tokens' 字段(如 128000),\n"
                f"  或设置环境变量 {ENV_NO_AUTO_LOOKUP}=1 关闭自动联网并使用默认值 "
                f"{DEFAULT_CONTEXT_LIMIT}。"
            ) from exc
        logger.warning(
            "无法确定模型 {} 的上下文窗口大小,使用默认值 {}: {}",
            model, DEFAULT_CONTEXT_LIMIT, exc,
        )
        return DEFAULT_CONTEXT_LIMIT

    _save_learned_limit(key, limit, source=source, hf_model_id=hf_model_id)
    logger.info(
        "模型 {} 上下文窗口: 查询到 {} tokens (source: {}, id: {})",
        model, limit, source, hf_model_id,
    )
    return limit


def learn_model_context_limit(
    model: str,
    provider: str = "auto",
) -> dict[str, Any]:
    """Actively learn a model's context window by querying Hugging Face.

    Called by the settings API when a model is saved/selected. If the model
    is already in the learning table, returns the cached entry without
    re-querying HF (model upgrades with new names are treated as new models).

    Returns:
        A dict describing the outcome for UI feedback:
        {
            "status": "ok" | "failed",
            "limit": int | None,
            "source": str | None,        # "huggingface:..." | "learning_table"
            "hf_model_id": str | None,
            "error": str | None,
        }
    """
    key = _normalize_model_name(model)
    if not key:
        return {
            "status": "failed",
            "limit": None,
            "source": None,
            "hf_model_id": None,
            "error": "模型名为空",
        }

    # Already learned successfully — return cached entry (no re-query, no TTL).
    # Failure records are NOT cached: re-query on each save so the user can
    # retry (e.g. after a transient network error). The failure reason is
    # still surfaced via _resolve_context_window_for_settings on page loads.
    existing = _load_learned_entry(key)
    if existing is not None and isinstance(existing.get("limit"), int):
        return {
            "status": "ok",
            "limit": existing.get("limit"),
            "source": "learning_table",
            "hf_model_id": existing.get("hf_model_id"),
            "error": None,
        }

    if os.environ.get(ENV_NO_AUTO_LOOKUP):
        return {
            "status": "failed",
            "limit": None,
            "source": None,
            "hf_model_id": None,
            "error": f"自动查询已被环境变量 {ENV_NO_AUTO_LOOKUP} 禁用",
        }

    try:
        limit, source, hf_model_id = _query_model_context_limit(model, key)
    except Exception as exc:
        return {
            "status": "failed",
            "limit": None,
            "source": None,
            "hf_model_id": None,
            "error": str(exc),
        }

    _save_learned_limit(key, limit, source=source, hf_model_id=hf_model_id)
    return {
        "status": "ok",
        "limit": limit,
        "source": source,
        "hf_model_id": hf_model_id,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Permanent learning table (replaces the old 7-day TTL cache).
# ---------------------------------------------------------------------------

def _get_learning_table_path() -> Path:
    """Return the permanent learning table path under the instance data dir."""
    try:
        from miniUnicorn.config.paths import get_runtime_subdir
        return get_runtime_subdir("cache") / "model_context_learned.json"
    except Exception:
        # Fallback when config loader is not yet initialized (rare).
        return Path.home() / ".miniUnicorn-cache" / "model_context_learned.json"


def _load_learning_table() -> dict[str, Any]:
    """Load the full learning table (best-effort)."""
    try:
        path = _get_learning_table_path()
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        logger.debug("读取模型上下文学习表失败: {}", exc)
        return {}


def _load_learned_entry(model_key: str) -> dict[str, Any] | None:
    """Return a learned entry dict (with source/hf_model_id) or None."""
    data = _load_learning_table()
    entry = data.get(model_key)
    if not isinstance(entry, dict):
        return None
    return entry


def _load_learned_limit(model_key: str) -> int | None:
    """Return a learned context limit (permanent, no TTL)."""
    entry = _load_learned_entry(model_key)
    if entry is None:
        return None
    limit = entry.get("limit")
    if isinstance(limit, int) and limit > 0:
        return limit
    return None


def _save_learned_limit(
    model_key: str, limit: int, *, source: str, hf_model_id: str | None,
) -> None:
    """Persist a learned context limit to the permanent table (best-effort)."""
    try:
        path = _get_learning_table_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        data = _load_learning_table()
        data[model_key] = {
            "limit": limit,
            "source": source,
            "hf_model_id": hf_model_id,
            "ts": time.time(),
            "model_name_at_query": model_key,
        }
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.debug("写入模型上下文学习表失败: {}", exc)


def _save_learned_failure(model_key_raw: str, error: str) -> None:
    """Persist a query failure to the learning table so the UI can show it.

    Unlike :func:`_save_learned_limit`, this stores no ``limit`` field —
    callers detect failure entries by the absence of a positive ``limit``.
    """
    key = _normalize_model_name(model_key_raw)
    if not key:
        return
    try:
        path = _get_learning_table_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        data = _load_learning_table()
        data[key] = {
            "limit": None,
            "source": None,
            "hf_model_id": None,
            "error": error,
            "ts": time.time(),
            "model_name_at_query": key,
        }
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.debug("写入模型上下文学习表(失败记录)失败: {}", exc)


# ---------------------------------------------------------------------------
# Hugging Face query: direct candidates + search API.
# ---------------------------------------------------------------------------

# Heuristic mapping from model-name prefix to Hugging Face organization.
# Used when the caller's model id has no namespace (e.g. "deepseek-chat"
# instead of "deepseek-ai/deepseek-chat").
_HF_ORG_HINTS: dict[str, str] = {
    "deepseek": "deepseek-ai",
    "qwen": "Qwen",
    "glm": "THUDM",
    "chatglm": "THUDM",
    "baichuan": "baichuan-inc",
    "yi": "01-ai",
    "mistral": "mistralai",
    "mixtral": "mistralai",
    "llama": "meta-llama",
    "gemma": "google",
    "phi": "microsoft",
    "bert": "google-bert",
    "roberta": "FacebookAI",
    "t5": "google-t5",
    "internlm": "internlm",
    "aquila": "BAAI",
    "skywork": "Skywork",
    "minicpm": "openbmb",
    "olmo": "allenai",
    "falcon": "tiiuae",
    "hy3": "tencent",
    "hunyuan": "tencent",
}


def _hf_model_id_candidates(model: str, key: str) -> list[str]:
    """Generate Hugging Face model id candidates to try in order (direct).

    These are tried before falling back to the search API.
    """
    candidates: list[str] = []
    seen: set[str] = set()

    def add(candidate: str) -> None:
        candidate = candidate.strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            candidates.append(candidate)

    # 1) Original input (may already include a namespace like "deepseek-ai/...").
    add(model)
    # 2) Guess org from name prefix.
    base = key.split("/")[-1]
    first_token = base.split("-")[0].lower()
    org = _HF_ORG_HINTS.get(first_token)
    if org:
        add(f"{org}/{base}")
    # 3) Bare normalized key as last resort (rarely valid on HF).
    add(key)
    return candidates


def _search_hf_models(model_key: str) -> list[str]:
    """Use HF search API to find candidate model ids matching *model_key*.

    ``GET https://huggingface.co/api/models?search=<query>&limit=N``

    Tries progressively shorter search queries (by removing the last ``-``
    segment) so that API aliases like ``hy3-free`` still find the base repo
    ``tencent/Hy3``. Returns a list of full model ids (e.g.
    ``["tencent/Hy3"]``) sorted by download count (HF default ordering).
    """
    base = model_key.split("/")[-1].strip()
    if not base:
        return []

    # Build a list of search queries: full name, then progressively shorter
    # prefixes obtained by stripping the last ``-`` segment.
    segments = base.split("-")
    queries: list[str] = [base]
    for i in range(len(segments) - 1, 0, -1):
        shorter = "-".join(segments[:i])
        if shorter and shorter not in queries:
            queries.append(shorter)

    # Determine the expected org from the model name prefix (for filtering).
    first_token = segments[0].lower()
    expected_org = _HF_ORG_HINTS.get(first_token)

    all_ids: list[str] = []
    seen: set[str] = set()
    for query in queries:
        try:
            resp = httpx.get(
                HF_SEARCH_BASE,
                params={"search": query, "limit": HF_SEARCH_MAX_CANDIDATES * 2},
                timeout=HF_SEARCH_TIMEOUT_S,
                follow_redirects=True,
            )
            resp.raise_for_status()
            items = resp.json()
            if not isinstance(items, list):
                continue
        except Exception as exc:
            logger.debug("HF search API 查询失败 (query={!r}): {}", query, exc)
            continue

        for item in items:
            if not isinstance(item, dict):
                continue
            mid = item.get("id")
            if isinstance(mid, str) and mid and mid not in seen:
                seen.add(mid)
                all_ids.append(mid)

    # Prioritize results from the expected org (if known), then by order.
    if expected_org:
        org_prefix = f"{expected_org}/"
        prioritized = [mid for mid in all_ids if mid.startswith(org_prefix)]
        others = [mid for mid in all_ids if not mid.startswith(org_prefix)]
        all_ids = prioritized + others

    return all_ids[: HF_SEARCH_MAX_CANDIDATES * 2]


def _extract_context_from_hf_model_card(data: dict[str, Any]) -> int | None:
    """Extract context window size from a Hugging Face model card JSON.

    Looks at common fields across architectures:
    - ``config.max_position_embeddings`` (most transformers models)
    - ``config.context_length`` / ``config.n_positions`` / ``config.seq_length``
    - ``config.max_seq_len`` / ``config.max_sequence_length``
    - ``tokenizer_config.model_max_length``
    - ``cardData.context_length`` (README YAML front matter)
    """
    config = data.get("config")
    if isinstance(config, dict):
        for field in (
            "max_position_embeddings",
            "context_length",
            "n_positions",
            "seq_length",
            "max_seq_len",
            "max_sequence_length",
        ):
            val = config.get(field)
            if isinstance(val, int) and val > 0:
                return val
    tokenizer_config = data.get("tokenizer_config")
    if isinstance(tokenizer_config, dict):
        val = tokenizer_config.get("model_max_length")
        if isinstance(val, int) and val > 0:
            return val
    card_data = data.get("cardData")
    if isinstance(card_data, dict):
        for field in ("context_length", "contextLength"):
            val = card_data.get(field)
            if isinstance(val, int) and val > 0:
                return val
    return None


def _extract_context_from_config_json(data: Any) -> int | None:
    """Extract context window from a raw ``config.json`` payload."""
    if not isinstance(data, dict):
        return None
    for field in (
        "max_position_embeddings",
        "context_length",
        "n_positions",
        "seq_length",
        "max_seq_len",
        "max_sequence_length",
        "sliding_window",  # Mistral uses this; treat as effective ctx
    ):
        val = data.get(field)
        if isinstance(val, int) and val > 0:
            return val
    return None


def _extract_context_from_tokenizer_config(data: Any) -> int | None:
    """Extract context window from a raw ``tokenizer_config.json`` payload."""
    if not isinstance(data, dict):
        return None
    val = data.get("model_max_length")
    if isinstance(val, int) and val > 0 and val < (1 << 31):
        # transformers uses (1 << 31) - 1 as "unbounded"; skip that sentinel.
        return val
    return None


def _query_hf_card_and_configs(model_id: str) -> tuple[int, str] | None:
    """Try the three HF endpoints for a single *model_id*.

    Returns ``(limit, source)`` where source identifies which endpoint
    yielded the value, or ``None`` if all three fail.
    """
    # 1) Model card metadata.
    try:
        resp = httpx.get(
            f"{HF_API_BASE}/{model_id}",
            timeout=HF_QUERY_TIMEOUT_S,
            follow_redirects=True,
        )
        if resp.status_code != 404:
            resp.raise_for_status()
            payload = resp.json()
            if isinstance(payload, dict):
                limit = _extract_context_from_hf_model_card(payload)
                if limit:
                    return limit, f"huggingface:card:{model_id}"
    except Exception:
        pass

    # 2) Raw config.json.
    try:
        resp = httpx.get(
            f"{HF_RAW_BASE}/{model_id}/resolve/main/config.json",
            timeout=HF_QUERY_TIMEOUT_S,
            follow_redirects=True,
        )
        if resp.status_code == 200:
            cfg = resp.json()
            limit = _extract_context_from_config_json(cfg)
            if limit:
                return limit, f"huggingface:config:{model_id}"
    except Exception:
        pass

    # 3) Raw tokenizer_config.json.
    try:
        resp = httpx.get(
            f"{HF_RAW_BASE}/{model_id}/resolve/main/tokenizer_config.json",
            timeout=HF_QUERY_TIMEOUT_S,
            follow_redirects=True,
        )
        if resp.status_code == 200:
            tc = resp.json()
            limit = _extract_context_from_tokenizer_config(tc)
            if limit:
                return limit, f"huggingface:tokenizer:{model_id}"
    except Exception:
        pass

    return None


def _query_hf_context_limit_with_search(
    model: str, key: str,
) -> tuple[int, str, str]:
    """Query Hugging Face for the model's context window.

    Strategy:
    1. Try direct namespace candidates (original input + org hints + bare key).
    2. If all direct candidates fail, use the HF search API to find matches
       and query each result's config files.

    Returns:
        ``(limit, source, hf_model_id)`` where *source* is a descriptive
        string identifying which endpoint yielded the value, and
        *hf_model_id* is the HF repo id that was queried.

    Raises:
        RuntimeError: if no candidate yields a context value.
    """
    errors: list[str] = []
    tried: set[str] = set()

    # 1) Direct candidates (original input + org hints).
    direct_candidates = _hf_model_id_candidates(model, key)
    for model_id in direct_candidates:
        tried.add(model_id)
        result = _query_hf_card_and_configs(model_id)
        if result is not None:
            limit, source = result
            logger.info(
                "模型 {} 上下文窗口: 通过 HuggingFace 直接查询到 {} tokens (source: {})",
                model, limit, source,
            )
            return limit, source, model_id
        errors.append(f"{model_id}: 直接查询失败")

    # 2) Search API for additional candidates.
    search_candidates = _search_hf_models(key)
    for model_id in search_candidates:
        if model_id in tried:
            continue
        tried.add(model_id)
        result = _query_hf_card_and_configs(model_id)
        if result is not None:
            limit, source = result
            logger.info(
                "模型 {} 上下文窗口: 通过 HuggingFace search 查询到 {} tokens "
                "(source: {}, hf_id: {})",
                model, limit, source, model_id,
            )
            return limit, source, model_id
        errors.append(f"{model_id}: search 查询失败")

    raise RuntimeError(
        f"无法从 HuggingFace 查询模型 '{model}' 的上下文窗口; "
        f"尝试了 {len(tried)} 个候选(直接 + 搜索),均失败: "
        + "; ".join(errors[:3])
    )


# ---------------------------------------------------------------------------
# ModelScope fallback (国产模型仓库,国内站点不走代理)
# ---------------------------------------------------------------------------

# ModelScope 的 namespace 与 HF 不完全一致(如 tencent/Hy3 在 HF,
# Tencent-Hunyuan/Hy3 在 ModelScope),这里维护一份独立的 org hints。
_MODELSCOPE_ORG_HINTS: dict[str, str] = {
    "deepseek": "deepseek-ai",
    "qwen": "Qwen",
    "glm": "ZhipuAI",
    "chatglm": "ZhipuAI",
    "baichuan": "baichuan-inc",
    "yi": "01-ai",
    "mistral": "AI-ModelScope",
    "mixtral": "AI-ModelScope",
    "llama": "LLM-Research",
    "gemma": "AI-ModelScope",
    "phi": "AI-ModelScope",
    "internlm": "Shanghai_AI_Laboratory",
    "aquila": "BAAI",
    "skywork": "Skywork",
    "minicpm": "OpenBMB",
    "hy3": "Tencent-Hunyuan",
    "hunyuan": "Tencent-Hunyuan",
}


def _modelscope_model_id_candidates(model: str, key: str) -> list[str]:
    """Generate ModelScope model id candidates to try in order (direct)."""
    candidates: list[str] = []
    seen: set[str] = set()

    def add(candidate: str) -> None:
        candidate = candidate.strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            candidates.append(candidate)

    # 1) Original input (may already include a namespace).
    add(model)
    # 2) Guess org from name prefix (ModelScope-specific namespace).
    base = key.split("/")[-1]
    first_token = base.split("-")[0].lower()
    org = _MODELSCOPE_ORG_HINTS.get(first_token)
    if org:
        add(f"{org}/{base}")
    # 3) Bare normalized key.
    add(key)
    return candidates


def _search_modelscope_models(model_key: str) -> list[str]:
    """Use ModelScope search API to find candidate model ids.

    ``PUT https://modelscope.cn/api/v1/models`` with body
    ``{"PageSize": N, "PageNumber": 1, "Name": "<query>"}``

    Tries progressively shorter search queries (by stripping the last
    ``-`` segment) so aliases like ``hy3-free`` still find ``Tencent-Hunyuan/Hy3``.
    Returns a list of full model ids (e.g. ``["Tencent-Hunyuan/Hy3"]``).
    """
    base = model_key.split("/")[-1].strip()
    if not base:
        return []

    segments = base.split("-")
    queries: list[str] = [base]
    for i in range(len(segments) - 1, 0, -1):
        shorter = "-".join(segments[:i])
        if shorter and shorter not in queries:
            queries.append(shorter)

    first_token = segments[0].lower()
    expected_org = _MODELSCOPE_ORG_HINTS.get(first_token)

    all_ids: list[str] = []
    seen: set[str] = set()
    for query in queries:
        try:
            # trust_env=False: ModelScope 是国内站点,不走代理。
            with httpx.Client(trust_env=False) as client:
                resp = client.put(
                    MODELSCOPE_API_BASE,
                    json={
                        "PageSize": MODELSCOPE_SEARCH_MAX_CANDIDATES * 2,
                        "PageNumber": 1,
                        "Name": query,
                    },
                    timeout=MODELSCOPE_SEARCH_TIMEOUT_S,
                    follow_redirects=True,
                )
            if resp.status_code != 200:
                continue
            data = resp.json()
            if not isinstance(data, dict) or not data.get("Success"):
                continue
            items = (data.get("Data") or {}).get("Models") or []
        except Exception as exc:
            logger.debug("ModelScope search API 查询失败 (query={!r}): {}", query, exc)
            continue

        for item in items:
            if not isinstance(item, dict):
                continue
            path = item.get("Path")
            name = item.get("Name")
            if isinstance(path, str) and isinstance(name, str) and path and name:
                mid = f"{path}/{name}"
                if mid not in seen:
                    seen.add(mid)
                    all_ids.append(mid)

    if expected_org:
        org_prefix = f"{expected_org}/"
        prioritized = [mid for mid in all_ids if mid.startswith(org_prefix)]
        others = [mid for mid in all_ids if not mid.startswith(org_prefix)]
        all_ids = prioritized + others

    return all_ids[: MODELSCOPE_SEARCH_MAX_CANDIDATES * 2]


def _query_modelscope_config(model_id: str) -> tuple[int, str] | None:
    """Query ModelScope for a single *model_id*'s config.json.

    ModelScope 暴露的 config.json 端点:
    ``GET /api/v1/models/{id}/repo?Revision=master&FilePath=config.json``

    Returns ``(limit, source)`` or ``None`` on failure.
    """
    try:
        # trust_env=False: ModelScope 是国内站点,不走代理。
        with httpx.Client(trust_env=False) as client:
            resp = client.get(
                f"{MODELSCOPE_RAW_BASE}/{model_id}/repo",
                params={"Revision": "master", "FilePath": "config.json"},
                timeout=MODELSCOPE_QUERY_TIMEOUT_S,
                follow_redirects=True,
            )
        if resp.status_code != 200:
            return None
        cfg = resp.json()
        if not isinstance(cfg, dict):
            return None
        limit = _extract_context_from_config_json(cfg)
        if limit:
            return limit, f"modelscope:config:{model_id}"
    except Exception:
        pass
    return None


def _query_modelscope_with_search(
    model: str, key: str,
) -> tuple[int, str, str]:
    """Query ModelScope for the model's context window (HF fallback).

    Strategy mirrors the HF query: direct candidates first, then search API.

    Returns:
        ``(limit, source, model_id)``.

    Raises:
        RuntimeError: if no candidate yields a context value.
    """
    errors: list[str] = []
    tried: set[str] = set()

    # 1) Direct candidates.
    for model_id in _modelscope_model_id_candidates(model, key):
        tried.add(model_id)
        result = _query_modelscope_config(model_id)
        if result is not None:
            limit, source = result
            logger.info(
                "模型 {} 上下文窗口: 通过 ModelScope 直接查询到 {} tokens (source: {})",
                model, limit, source,
            )
            return limit, source, model_id
        errors.append(f"{model_id}: 直接查询失败")

    # 2) Search API.
    for model_id in _search_modelscope_models(key):
        if model_id in tried:
            continue
        tried.add(model_id)
        result = _query_modelscope_config(model_id)
        if result is not None:
            limit, source = result
            logger.info(
                "模型 {} 上下文窗口: 通过 ModelScope search 查询到 {} tokens "
                "(source: {}, ms_id: {})",
                model, limit, source, model_id,
            )
            return limit, source, model_id
        errors.append(f"{model_id}: search 查询失败")

    raise RuntimeError(
        f"无法从 ModelScope 查询模型 '{model}' 的上下文窗口; "
        f"尝试了 {len(tried)} 个候选(直接 + 搜索),均失败: "
        + "; ".join(errors[:3])
    )


def _query_model_context_limit(
    model: str, key: str,
) -> tuple[int, str, str]:
    """Query Hugging Face first, then ModelScope as fallback.

    Returns ``(limit, source, model_id)``. Raises RuntimeError if both fail.
    """
    try:
        return _query_hf_context_limit_with_search(model, key)
    except Exception as hf_exc:
        logger.debug(
            "HuggingFace 查询失败,尝试 ModelScope fallback: {}", hf_exc,
        )
        try:
            return _query_modelscope_with_search(model, key)
        except Exception as ms_exc:
            raise RuntimeError(
                f"HuggingFace 和 ModelScope 均查询失败。"
                f"HF 错误: {hf_exc}; ModelScope 错误: {ms_exc}"
            ) from ms_exc


def get_model_suggestions(_partial: str, provider: str = "auto", limit: int = 20) -> list[str]:
    """Return up to *limit* model family names matching *_partial*.

    With the built-in table removed, this always returns an empty list.
    Signature preserved for callers (e.g. onboard wizard).
    """
    return []


def format_token_count(tokens: int) -> str:
    """Format token count for display (e.g., 200000 -> '200,000')."""
    return f"{tokens:,}"
