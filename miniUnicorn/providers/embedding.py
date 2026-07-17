"""Dedicated embedding provider.

Supports using a different provider for embeddings than for chat
(e.g., Anthropic Claude for chat + OpenAI for embeddings).
Falls back to the main LLM provider's embed() if no separate
embedding config is provided.
"""
from __future__ import annotations

from typing import Any

from loguru import logger


class EmbeddingProvider:
    """Wraps embedding calls, optionally using a separate config from chat."""

    def __init__(
        self,
        main_provider: Any,
        embedding_config: dict | None = None,
    ):
        self._main = main_provider
        self._embed_client = None
        self._config = embedding_config or {}
        self._separate = bool(self._config.get("embedding_provider"))

    @property
    def enabled(self) -> bool:
        """Whether embeddings are available."""
        if self._separate:
            return True  # Will try on first call
        try:
            # Check if main provider supports embed
            # (will raise NotImplementedError if not)
            return hasattr(self._main, "embed")
        except Exception:
            return False

    async def embed(self, texts: list[str], model: str | None = None) -> list[list[float]]:
        """Generate embeddings, using separate config if available."""
        if not texts:
            return []

        if self._separate:
            return await self._embed_via_separate(texts, model)

        # Fall back to main provider
        try:
            use_model = model or self._config.get("embedding_model", "text-embedding-3-small")
            return await self._main.embed(texts, model=use_model)
        except (NotImplementedError, AttributeError):
            logger.warning("Main provider does not support embeddings; returning empty")
            return []

    async def _embed_via_separate(self, texts: list[str], model: str | None = None) -> list[list[float]]:
        """Use a separate OpenAI-compatible endpoint for embeddings."""
        from openai import AsyncOpenAI

        if self._embed_client is None:
            api_key = self._config.get("embedding_api_key") or ""
            api_base = self._config.get("embedding_api_base") or "https://api.openai.com/v1"
            self._embed_client = AsyncOpenAI(api_key=api_key, base_url=api_base)

        use_model = model or self._config.get("embedding_model", "text-embedding-3-small")
        try:
            resp = await self._embed_client.embeddings.create(model=use_model, input=texts)
            sorted_data = sorted(resp.data, key=lambda x: x.index)
            return [item.embedding for item in sorted_data]
        except Exception:
            logger.exception("Separate embedding failed for model {}", use_model)
            raise
