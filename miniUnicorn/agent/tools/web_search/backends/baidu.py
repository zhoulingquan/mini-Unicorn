"""百度搜索后端 - 免 API Key,直接抓取 baidu.com 搜索结果页。"""

from __future__ import annotations

import re
from urllib.parse import urljoin

from loguru import logger

from miniUnicorn.agent.tools.web_search.backends._html_utils import (
    clean_snippet,
    encode_query,
    make_absolute_url,
    strip_tags,
)
from miniUnicorn.agent.tools.web_search.backends.base import (
    BackendResponse,
    SearchBackend,
    SearchResult,
)

_SEARCH_URL = "https://www.baidu.com/s?wd={query}&rn={count}"
# 结果容器<div class="result ...">...</div>
_RESULT_RE = re.compile(
    r'<div\s+class="result[^"]*"[^>]*>([\s\S]*?)</div>\s*(?=<div\s+class="result|<div\s+id="content_left"|$)',
    re.I,
)
# 标题链接 <a href="..." ...>title</a>(在 h3 内)
_LINK_RE = re.compile(
    r'<h3[^>]*>\s*<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>',
    re.I,
)
# 摘要 <span class="content_right_8">...</span> 或通用 class
_SNIPPET_RE = re.compile(
    r'<(?:span|div)[^>]*class="[^"]*(?:content_right_8|c-abstract|c-span-last)[^"]*"[^>]*>([\s\S]*?)</(?:span|div)>',
    re.I,
)


class BaiduBackend(SearchBackend):
    """baidu.com 抓取后端。"""

    name = "baidu"
    requires_api_key = False
    needs_proxy_in_cn = False

    async def search(self, query: str, count: int) -> BackendResponse:
        url = _SEARCH_URL.format(query=encode_query(query), count=min(count * 2, 20))
        try:
            async with self.make_client() as client:
                resp = await client.get(
                    url,
                    headers={
                        "User-Agent": self.user_agent,
                        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    },
                )
                resp.raise_for_status()
                html_text = resp.text
        except Exception as e:
            logger.debug("baidu search failed: {}", e)
            return BackendResponse(backend=self.name, error=f"baidu fetch failed: {type(e).__name__}: {e}")

        results = self._parse(html_text, count)
        if not results:
            return BackendResponse(
                backend=self.name,
                error="baidu parse failed: no results (may be blocked or HTML changed)",
            )
        return BackendResponse(backend=self.name, results=results)

    def _parse(self, html_text: str, count: int) -> list[SearchResult]:
        results: list[SearchResult] = []
        for match in _RESULT_RE.finditer(html_text):
            block = match.group(1)
            link_match = _LINK_RE.search(block)
            if not link_match:
                continue
            url = make_absolute_url("https://www.baidu.com", link_match.group(1))
            title = strip_tags(link_match.group(2))
            if not title or not url:
                continue
            snippet = ""
            sn_match = _SNIPPET_RE.search(block)
            if sn_match:
                snippet = clean_snippet(sn_match.group(1))
            results.append(
                SearchResult(
                    title=title,
                    url=url,
                    snippet=snippet,
                    source_backend=self.name,
                )
            )
            if len(results) >= count:
                break
        return results
