"""搜索后端实现。"""

from miniUnicorn.agent.tools.web_search.backends.base import SearchResult, SearchBackend
from miniUnicorn.agent.tools.web_search.backends.bing_cn import BingCnBackend
from miniUnicorn.agent.tools.web_search.backends.baidu import BaiduBackend
from miniUnicorn.agent.tools.web_search.backends.sogou import SogouBackend
from miniUnicorn.agent.tools.web_search.backends.duckduckgo import DuckDuckGoBackend
from miniUnicorn.agent.tools.web_search.backends.bocha import BochaBackend
from miniUnicorn.agent.tools.web_search.backends.tencent import TencentBackend

# 后端注册表: name -> Backend 类
BACKEND_REGISTRY: dict[str, type[SearchBackend]] = {
    "bing_cn": BingCnBackend,
    "baidu": BaiduBackend,
    "sogou": SogouBackend,
    "duckduckgo": DuckDuckGoBackend,
    "bocha": BochaBackend,
    "tencent": TencentBackend,
}

__all__ = [
    "SearchResult",
    "SearchBackend",
    "BACKEND_REGISTRY",
    "BingCnBackend",
    "BaiduBackend",
    "SogouBackend",
    "DuckDuckGoBackend",
    "BochaBackend",
    "TencentBackend",
]
