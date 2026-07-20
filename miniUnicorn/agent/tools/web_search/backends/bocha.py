"""博查 Bocha AI Search API 后端。

国内首家 Search API for AI,内容合规,适合国内业务。
- API 文档: https://bochaai.com/docs/api
- 需要注册获取 API Key(免费额度)
"""

from __future__ import annotations

from loguru import logger

from miniUnicorn.agent.tools.web_search.backends.base import (
    BackendResponse,
    SearchBackend,
    SearchResult,
)

_DEFAULT_BASE_URL = "https://api.bochaai.com"
_SEARCH_PATH = "/v1/web-search"
_ENV_VAR = "BOCHA_API_KEY"


class BochaBackend(SearchBackend):
    """博查 AI Search API 后端。"""

    name = "bocha"
    requires_api_key = True
    env_var = _ENV_VAR
    needs_proxy_in_cn = False

    async def search(self, query: str, count: int) -> BackendResponse:
        api_key = self.get_api_key()
        if not api_key:
            return BackendResponse(
                backend=self.name,
                error=f"bocha: api_key not set (config.web_search.backends.bocha.api_key or env {_ENV_VAR})",
            )

        backend_cfg = self.config.get_backend_config(self.name)
        base_url = (backend_cfg.base_url or _DEFAULT_BASE_URL).rstrip("/")

        try:
            async with self.make_client() as client:
                resp = await client.post(
                    f"{base_url}{_SEARCH_PATH}",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "query": query,
                        "count": count,
                        "summary": False,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            logger.debug("bocha search failed: {}", e)
            return BackendResponse(
                backend=self.name,
                error=f"bocha fetch failed: {type(e).__name__}: {e}",
            )

        results = self._parse(data, count)
        if not results:
            return BackendResponse(backend=self.name, error="bocha: no results in response")
        return BackendResponse(backend=self.name, results=results)

    def _parse(self, data: dict, count: int) -> list[SearchResult]:
        """解析博查 API 响应。

        响应结构(参考 https://bochaai.com/docs/api):
        {
          "data": {
            "webPages": {
              "value": [
                {"name": "...", "url": "...", "summary": "...", "snippet": "..."},
                ...
              ]
            }
          }
        }
        """
        web_pages = (data.get("data") or {}).get("webPages") or {}
        items = web_pages.get("value") or []
        results: list[SearchResult] = []
        for item in items[:count]:
            title = str(item.get("name") or item.get("title") or "")
            url = str(item.get("url") or item.get("link") or "")
            snippet = str(item.get("summary") or item.get("snippet") or item.get("description") or "")
            if not title or not url:
                continue
            results.append(
                SearchResult(
                    title=title,
                    url=url,
                    snippet=snippet,
                    source_backend=self.name,
                )
            )
        return results
