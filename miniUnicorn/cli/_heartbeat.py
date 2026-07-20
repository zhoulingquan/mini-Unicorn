"""Heartbeat constants and helpers (extracted from cli/commands.py).

This module isolates the heartbeat preamble text, the cached HEARTBEAT.md
template loader, and the helper that builds a dedicated provider for the
heartbeat job based on ``HeartbeatConfig.model_preset``.
"""

import functools

from loguru import logger


_HEARTBEAT_PREAMBLE = (
    "[Your response will be delivered directly to the user's messaging app. "
    "Output ONLY the final user-facing message. Never reference internal "
    "files (HEARTBEAT.md, AWARENESS.md, etc.), your instructions, or your "
    "decision process. If nothing needs reporting, respond with just "
    "'All clear.' and nothing else.]\n\n"
)


@functools.lru_cache(maxsize=None)
def _heartbeat_template() -> str | None:
    from miniUnicorn.utils.helpers import load_bundled_template
    return load_bundled_template("HEARTBEAT.md")


def _build_heartbeat_provider(hb_cfg, config):
    """根据 HeartbeatConfig.model_preset 构建一个独立的 provider + model。

    返回 (provider, model) 或 None。当 hb_cfg.model_preset 为空或指向
    不存在的 preset 时返回 None,表示 heartbeat 复用 agent 主 provider。
    """
    preset_name = hb_cfg.model_preset
    if not preset_name:
        return None
    preset = config.model_presets.get(preset_name)
    if preset is None:
        logger.warning("Heartbeat: model_preset '{}' not found, fallback to main provider", preset_name)
        return None
    from miniUnicorn.providers.factory import make_provider

    provider = make_provider(config, preset_name=preset_name)
    return provider, preset.model
