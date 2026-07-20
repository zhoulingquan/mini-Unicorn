"""Per-chat streaming accumulator for the Feishu CardKit streaming API.

Extracted from ``channel.py`` so the small dataclass has its own module.
``FeishuChannel`` keeps one ``_FeishuStreamBuf`` per active stream key and
mutates ``text`` / ``sequence`` as CardKit streaming updates are pushed.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class _FeishuStreamBuf:
    """Per-chat streaming accumulator using CardKit streaming API."""

    text: str = ""
    card_id: str | None = None
    sequence: int = 0
    last_edit: float = 0.0
