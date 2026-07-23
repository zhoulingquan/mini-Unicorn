# web_search HTML 抓取鲁棒性完善方案

> 范围：`miniUnicorn/agent/tools/web_search/` 模块中 baidu/sogou 等 HTML 抓取后端的鲁棒性增强
> 目标：在不破坏"国内零配置可用"核心优势的前提下，将 HTML 抓取后端的改版容错性、风控抗性、可观测性提升到生产可用水平
> 原则：分层防御、最小侵入、可回归测试

---

## 一、问题诊断

### 1.1 现状架构

```
WebSearchTool.execute()
    └─ SearchAggregator.search()
           ├─ _search_single()     ← 无重试、无熔断
           │    └─ backend.search()
           │           └─ HtmlScrapeBackend._fetch_html()  ← 无编码探测
           │                  └─ _parse()                   ← 纯正则,单模式
           └─ _search_concurrent()  ← 并发首成功,失败后端无重试
```

### 1.2 痛点清单

| # | 痛点 | 位置 | 严重度 | 触发场景 |
|---|---|---|---|---|
| P1 | 纯正则解析 HTML，div 嵌套即错乱 | [base.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web_search/backends/base.py) `_parse` 第 172-201 行 | 高 | 百度结果块含嵌套 div |
| P2 | 正则依赖精确 class 名，改版即失效 | [baidu.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web_search/backends/baidu.py) 第 11-24 行、[sogou.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web_search/backends/sogou.py) 第 11-24 行 | 高 | 搜索引擎改版 |
| P3 | 无编码探测，GBK 页面易乱码 | [base.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web_search/backends/base.py) 第 150 行 `resp.text` | 高 | baidu/sogou 返回 GBK |
| P4 | 无重试，单次网络抖动即失败 | [aggregator.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web_search/aggregator.py) 第 113 行 | 中 | 网络抖动/临时风控 |
| P5 | 无负缓存，parse failed 每次重试 | [cache.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web_search/cache.py) 无负缓存 | 中 | 改版期间高频无效请求 |
| P6 | 失败日志仅 debug 级，可观测性差 | [base.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web_search/backends/base.py) 第 158 行 | 中 | 生产环境看不到失败 |
| P7 | 无后端健康/熔断，风控后端每次都试 | 无（参考 [web.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web.py) `_JinaCircuitBreaker`） | 中 | IP 被风控后持续无效请求 |
| P8 | 无测试与 HTML 样本，无法回归 | tests/ 无 web_search 测试 | 高 | 改版无法提前发现 |

### 1.3 现有资产可复用

| 资产 | 位置 | 复用方式 |
|---|---|---|
| `chardet` 依赖已装但零 import | pyproject.toml 第 43 行 | 直接用于编码探测，零新增依赖 |
| `lxml` 作为 readability-lxml 传递依赖 | uv.lock 第 1121 行 | 可直接 import，但需升级为直接依赖以锁定 |
| `_JinaCircuitBreaker` 熔断器模式 | [web.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/agent/tools/web.py) 第 37-98 行 | 复刻为 `BackendCircuitBreaker` |
| `httpx.MockTransport` 测试范式 | [tests/tools/test_web_fetch_security.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/tests/tools/test_web_fetch_security.py) 第 229-253 行 | 后端单元测试基础 |
| `create_ssrf_safe_client(**kwargs)` 透传 | [security/network.py](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/miniUnicorn/security/network.py) 第 409-437 行 | make_client 扩展点 |

---

## 二、方案总览：分层防御架构

```
请求层    ┌─────────────────────────────────────────────────┐
         │ 1. 后端熔断检查 (BackendCircuitBreaker)            │ ← 风控后端跳过
         │ 2. 单后端重试 (max_retries=1, 指数退避)            │ ← 网络抖动
         └─────────────────────────────────────────────────┘
                              ↓
抓取层    ┌─────────────────────────────────────────────────┐
         │ 3. 编码探测 (chardet) + UA 轮换 + Referer          │ ← GBK 乱码/风控
         └─────────────────────────────────────────────────┘
                              ↓
解析层    ┌─────────────────────────────────────────────────┐
         │ 4. 风控页面检测 (验证码/安全验证特征)               │ ← 识别风控
         │ 5. 多模式解析链 (CSS选择器 → 正则V1 → JSON提取)    │ ← 改版容错
         └─────────────────────────────────────────────────┘
                              ↓
缓存层    ┌─────────────────────────────────────────────────┐
         │ 6. 负缓存 (parse failed 短TTL 60s)                │ ← 避免无效重试
         └─────────────────────────────────────────────────┘
                              ↓
可观测层  ┌─────────────────────────────────────────────────┐
         │ 7. 结构化日志 (warning 级失败 + 成功率统计)        │ ← 改版预警
         │ 8. 回归测试 (HTML fixtures + 解析契约测试)         │ ← 改版防护
         └─────────────────────────────────────────────────┘
```

---

## 三、详细设计

### 3.1 解析层：多模式解析链（P1/P2 核心改进）

#### 3.1.1 设计

引入 `selectolax`（纯 C、快、无 lxml 编译问题）作为首选解析器，正则作为兜底。

```python
# miniUnicorn/agent/tools/web_search/backends/_html_utils.py 新增

from __future__ import annotations

from dataclasses import dataclass
from typing import Pattern
from loguru import logger

try:
    from selectolax.parser import HTMLParser
    _HAS_SELECTOLAX = True
except ImportError:
    _HAS_SELECTOLAX = False
    logger.debug("selectolax 未安装,回退纯正则解析")


@dataclass
class ParsePattern:
    """单套解析规则,按优先级尝试。"""
    name: str                          # 规则名,用于日志
    # CSS 选择器(优先,更鲁棒)
    result_selector: str = ""          # 例如 "div.result"
    link_selector: str = ""            # 例如 "h3 a"
    snippet_selector: str = ""         # 例如 "span.content_right_8"
    # 正则(兜底)
    result_re: Pattern[str] | None = None
    link_re: Pattern[str] | None = None
    snippet_re: Pattern[str] | None = None


def parse_with_css(
    html_text: str,
    pattern: ParsePattern,
    count: int,
    base_url: str,
) -> list[tuple[str, str, str]]:
    """CSS 选择器解析,失败返回空列表。"""
    if not _HAS_SELECTOLAX or not pattern.result_selector:
        return []
    try:
        tree = HTMLParser(html_text)
        results: list[tuple[str, str, str]] = []
        for node in tree.css(pattern.result_selector):
            link_node = node.css_first(pattern.link_selector) if pattern.link_selector else None
            if not link_node:
                continue
            href = link_node.attributes.get("href", "") or ""
            title = link_node.text(strip=True)
            if not href or not title:
                continue
            snippet = ""
            if pattern.snippet_selector:
                sn_node = node.css_first(pattern.snippet_selector)
                if sn_node:
                    snippet = sn_node.text(separator=" ", strip=True)
            results.append((title, href, snippet))
            if len(results) >= count:
                break
        return results
    except Exception as e:
        logger.debug("CSS 解析失败 [{}]: {}", pattern.name, e)
        return []


def parse_with_regex(
    html_text: str,
    pattern: ParsePattern,
    count: int,
) -> list[tuple[str, str, str]]:
    """正则解析,失败返回空列表。"""
    if not pattern.result_re or not pattern.link_re:
        return []
    try:
        results: list[tuple[str, str, str]] = []
        for match in pattern.result_re.finditer(html_text):
            block = match.group(1)
            link_match = pattern.link_re.search(block)
            if not link_match:
                continue
            url = link_match.group(1)
            title = link_match.group(2) if link_match.re.groups >= 2 else ""
            snippet = ""
            if pattern.snippet_re:
                sn_match = pattern.snippet_re.search(block)
                if sn_match:
                    snippet = sn_match.group(1)
            results.append((title, url, snippet))
            if len(results) >= count:
                break
        return results
    except Exception as e:
        logger.debug("正则解析失败 [{}]: {}", pattern.name, e)
        return []
```

#### 3.1.2 HtmlScrapeBackend 改造

```python
# miniUnicorn/agent/tools/web_search/backends/base.py 改造

class HtmlScrapeBackend(SearchBackend):
    """免 API Key 的 HTML 抓取后端通用模板。

    子类通过 _PATTERNS 声明多套解析规则(按优先级),
    解析时依次尝试,首个成功即返回。
    """

    # 子类必须覆盖:
    _SEARCH_URL: str = ""
    _BASE_URL: str = ""
    _PATTERNS: list[ParsePattern] = []  # 按优先级排序

    # 兼容旧子类(仅声明正则的场景):
    _RESULT_RE: Pattern[str] = re.compile(r"$^")
    _LINK_RE: Pattern[str] = re.compile(r"$^")
    _SNIPPET_RE: Pattern[str] = re.compile(r"$^")

    def _get_patterns(self) -> list[ParsePattern]:
        """获取解析规则列表,兼容新旧两种声明方式。"""
        if self._PATTERNS:
            return self._PATTERNS
        # 兼容旧子类:从 _RESULT_RE 等构造单个 ParsePattern
        return [ParsePattern(
            name="legacy_regex",
            result_re=self._RESULT_RE,
            link_re=self._LINK_RE,
            snippet_re=self._SNIPPET_RE,
        )]

    def _parse(self, html_text: str, count: int) -> list[SearchResult]:
        # 风控检测
        block_type = _detect_block_type(html_text, self.name)
        if block_type:
            logger.warning("{} 被风控 [{}],跳过解析", self.name, block_type)
            return []

        # 多模式解析链
        for pattern in self._get_patterns():
            # 优先 CSS 选择器
            raw = parse_with_css(html_text, pattern, count, self._BASE_URL)
            if not raw and pattern.result_re:
                raw = parse_with_regex(html_text, pattern, count)
            if raw:
                logger.debug("{} 解析成功 [{}], {} 条结果",
                             self.name, pattern.name, len(raw))
                return self._build_results(raw)
            logger.debug("{} 模式 [{}] 无结果", self.name, pattern.name)

        logger.warning("{} 所有解析模式均失败", self.name)
        return []

    def _build_results(self, raw: list[tuple[str, str, str]]) -> list[SearchResult]:
        results: list[SearchResult] = []
        for title, url, snippet in raw:
            url = make_absolute_url(self._BASE_URL, url)
            title = strip_tags(title)
            if not title or not url:
                continue
            results.append(SearchResult(
                title=title,
                url=url,
                snippet=clean_snippet(snippet),
                source_backend=self.name,
            ))
        return results
```

#### 3.1.3 baidu.py 改造

```python
# miniUnicorn/agent/tools/web_search/backends/baidu.py

from __future__ import annotations
import re
from miniUnicorn.agent.tools.web_search.backends.base import HtmlScrapeBackend
from miniUnicorn.agent.tools.web_search.backends._html_utils import ParsePattern

# 模式1: CSS 选择器(首选,最鲁棒)
_PATTERN_CSS = ParsePattern(
    name="css_classic",
    result_selector="div.result, div.c-container",
    link_selector="h3 a",
    snippet_selector="span.content_right_8, div.c-abstract, span.c-span-last",
    # 同模式正则兜底
    result_re=re.compile(r'<div\s+class="result[^"]*"[^>]*>([\s\S]*?)</div>\s*(?=<div\s+class="result|<div\s+id="content_left"|$)', re.I),
    link_re=re.compile(r'<h3[^>]*>\s*<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', re.I),
    snippet_re=re.compile(r'<(?:span|div)[^>]*class="[^"]*(?:content_right_8|c-abstract|c-span-last)[^"]*"[^>]*>([\s\S]*?)</(?:span|div)>', re.I),
)

# 模式2: 嵌入 JSON 数据提取(百度部分结果用 JSON 渲染)
_PATTERN_JSON = ParsePattern(
    name="embedded_json",
    result_re=re.compile(r'"title"\s*:\s*"([^"]+)"[^}]*"url"\s*:\s*"([^"]+)"', re.I),
    link_re=re.compile(r'"url"\s*:\s*"([^"]+)"', re.I),
    snippet_re=re.compile(r'"abstract"\s*:\s*"([^"]*)"', re.I),
)


class BaiduBackend(HtmlScrapeBackend):
    """baidu.com 抓取后端。"""
    name = "baidu"
    requires_api_key = False
    needs_proxy_in_cn = False

    _BASE_URL = "https://www.baidu.com"
    _SEARCH_URL = "https://www.baidu.com/s?wd={query}&rn={count}"
    _PATTERNS = [_PATTERN_CSS, _PATTERN_JSON]
```

#### 3.1.4 sogou.py 改造

```python
# 同理,定义 CSS + 正则双模式
_PATTERN_CSS = ParsePattern(
    name="css_classic",
    result_selector="div.vrwrap, div.rb",
    link_selector="h3 a",
    snippet_selector="p.str-text-info, div.fz-mid.space-txt",
    result_re=re.compile(r'<div\s+class="(?:vrwrap|rb)"[^>]*>([\s\S]*?)</div>\s*(?=<div\s+class="(?:vrwrap|rb)"|<div\s+id="pagebar_container"|$)', re.I),
    link_re=re.compile(r'<h3[^>]*>\s*<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', re.I),
    snippet_re=re.compile(r'<(?:p|div)[^>]*class="[^"]*(?:str-text-info|str_info|space-txt|fz-mid)[^"]*"[^>]*>([\s\S]*?)</(?:p|div)>', re.I),
)
```

#### 3.1.5 依赖新增

```toml
# pyproject.toml
[project]
dependencies = [
    # ... 现有依赖
    "selectolax>=0.3.21,<1.0.0",  # 新增:HTML CSS 选择器解析
]
```

---

### 3.2 抓取层：编码探测 + UA 轮换（P3）

#### 3.2.1 编码探测

```python
# miniUnicorn/agent/tools/web_search/backends/_html_utils.py 新增

import chardet  # 已在依赖中,此前零使用


def detect_encoding(content: bytes, content_type: str = "") -> str:
    """探测 HTML 响应编码,优先级:HTTP header > meta charset > chardet > utf-8。"""
    # 1. HTTP Content-Type charset
    if "charset=" in content_type.lower():
        cs = content_type.lower().split("charset=")[-1].split(";")[0].strip()
        if cs:
            return cs

    # 2. HTML meta charset (前 4KB 探测)
    head = content[:4096].decode("ascii", errors="ignore")
    m = re.search(r'charset=["\']?([\w-]+)', head, re.I)
    if m:
        return m.group(1)

    # 3. chardet 统计探测
    try:
        detected = chardet.detect(content)
        if detected and detected["confidence"] > 0.7:
            return detected["encoding"] or "utf-8"
    except Exception:
        pass

    return "utf-8"
```

#### 3.2.2 _fetch_html 改造

```python
# miniUnicorn/agent/tools/web_search/backends/base.py 改造

async def _fetch_html(self, url: str) -> str:
    """发起 GET 请求并返回正确解码的文本。"""
    async with self.make_client() as client:
        resp = await client.get(url, headers=self._build_headers())
        resp.raise_for_status()
        # 用 chardet 探测编码,避免 GBK 乱码
        content_type = resp.headers.get("content-type", "")
        encoding = detect_encoding(resp.content, content_type)
        return resp.content.decode(encoding, errors="replace")
```

#### 3.2.3 UA 轮换

```python
# miniUnicorn/agent/tools/web_search/backends/base.py 新增

import random

_USER_AGENTS = [
    # 桌面 Chrome (主要)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    # 移动端 (降低风控概率)
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
]


def _build_headers(self) -> dict[str, str]:
    return {
        "User-Agent": random.choice(_USER_AGENTS),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": self._BASE_URL,  # 加 Referer 降低风控
    }
```

---

### 3.3 请求层：重试 + 熔断（P4/P7）

#### 3.3.1 后端熔断器

```python
# miniUnicorn/agent/tools/web_search/backends/_circuit_breaker.py 新增

from __future__ import annotations
import time
from collections import defaultdict
from loguru import logger


class BackendCircuitBreaker:
    """后端级熔断器:风控触发后冷却期内跳过该后端。

    进程内单例,参考 _JinaCircuitBreaker 模式。
    状态:closed(正常) → open(熔断,跳过) → half_open(试探)
    """
    _FAILURE_THRESHOLD = 3       # 连续失败 N 次触发熔断
    _COOLDOWN_S = 300.0          # 熔断冷却 5 分钟
    _HALF_OPEN_PROB = 0.2        # 冷却后 20% 概率试探

    # backend_name -> {"failures": int, "open_until": float}
    _state: dict[str, dict] = defaultdict(lambda: {"failures": 0, "open_until": 0.0})

    @classmethod
    def is_blocked(cls, name: str) -> bool:
        state = cls._state[name]
        now = time.time()
        if now < state["open_until"]:
            # 冷却期内,小概率放行试探
            import random
            if random.random() < cls._HALF_OPEN_PROB:
                logger.debug("{} 熔断 half_open 试探", name)
                return False
            return True
        # 冷却期过,自动重置
        if state["open_until"] > 0:
            state["failures"] = 0
            state["open_until"] = 0.0
        return False

    @classmethod
    def record_failure(cls, name: str, *, is_risk_control: bool = False) -> None:
        state = cls._state[name]
        # 风控失败立即熔断
        if is_risk_control:
            state["open_until"] = time.time() + cls._COOLDOWN_S
            logger.warning("{} 风控触发,熔断 {}s", name, cls._COOLDOWN_S)
            return
        state["failures"] += 1
        if state["failures"] >= cls._FAILURE_THRESHOLD:
            state["open_until"] = time.time() + cls._COOLDOWN_S
            logger.warning("{} 连续失败 {} 次,熔断 {}s",
                           name, state["failures"], cls._COOLDOWN_S)

    @classmethod
    def record_success(cls, name: str) -> None:
        cls._state[name]["failures"] = 0
        cls._state[name]["open_until"] = 0.0
```

#### 3.3.2 风控检测

```python
# miniUnicorn/agent/tools/web_search/backends/_html_utils.py 新增

_RISK_CONTROL_MARKERS = {
    "baidu": [
        "百度安全验证", "wappass.baidu.com", "请输入验证码",
        "异常访问", "user banned",
    ],
    "sogou": [
        "antispider", "搜狗验证", "请输入验证码",
    ],
    "generic": [
        "验证码", "captcha", "access denied", "blocked",
    ],
}


def detect_block_type(html_text: str, backend_name: str) -> str | None:
    """识别风控类型,返回 None 表示未被风控。"""
    text_lower = html_text.lower()
    # 短页面 + 验证关键词 = 高概率风控
    is_short = len(html_text) < 2000
    markers = _RISK_CONTROL_MARKERS.get(backend_name, []) + _RISK_CONTROL_MARKERS["generic"]
    for marker in markers:
        if marker.lower() in text_lower:
            if is_short or marker in ("wappass.baidu.com", "antispider"):
                return f"risk_control:{marker}"
    return None
```

#### 3.3.3 aggregator 重试改造

```python
# miniUnicorn/agent/tools/web_search/aggregator.py 改造 _search_single

async def _search_single(
    self, backend_name: str, query: str, count: int
) -> BackendResponse:
    # 熔断检查
    if BackendCircuitBreaker.is_blocked(backend_name):
        return BackendResponse(
            backend=backend_name,
            error=f"{backend_name} circuit breaker open",
        )

    # 缓存检查(含负缓存)
    cached = self.cache.get(backend_name, query, count)
    if cached is not None:
        return cached  # 可能是负缓存的空响应

    backend = self._make_backend(backend_name)
    max_retries = 1  # 单后端最多重试 1 次
    backoff_s = 0.5

    for attempt in range(max_retries + 1):
        resp = await backend.search(query, count)

        if resp.ok:
            BackendCircuitBreaker.record_success(backend_name)
            self.cache.set(backend_name, query, count, resp)
            return resp

        # 风控失败:立即熔断,不重试
        if "blocked" in resp.error or "risk_control" in resp.error:
            BackendCircuitBreaker.record_failure(backend_name, is_risk_control=True)
            self.cache.set_negative(backend_name, query, count, resp, ttl=60)
            return resp

        # 网络错误:重试一次
        if attempt < max_retries and "fetch failed" in resp.error:
            logger.debug("{} 网络错误,{}s 后重试", backend_name, backoff_s)
            await asyncio.sleep(backoff_s)
            continue

        # 解析失败:记录失败 + 负缓存
        BackendCircuitBreaker.record_failure(backend_name)
        self.cache.set_negative(backend_name, query, count, resp, ttl=60)
        return resp

    return resp
```

---

### 3.4 缓存层：负缓存（P5）

```python
# miniUnicorn/agent/tools/web_search/cache.py 改造

import time
from collections import OrderedDict


class SearchCache:
    """LRU + TTL 缓存,支持负缓存。"""

    _NEG_CACHE_TTL = 60  # 负缓存短 TTL,避免改版期间无效重试

    def __init__(self, max_size: int = 256, ttl: int = 3600) -> None:
        self._cache: OrderedDict[str, tuple[float, BackendResponse | None]] = OrderedDict()
        self._max_size = max_size
        self._ttl = ttl

    def _key(self, backend: str, query: str, count: int) -> str:
        return f"{backend}:{count}:{query.strip().lower()}"

    def get(self, backend: str, query: str, count: int) -> BackendResponse | None:
        key = self._key(backend, query, count)
        entry = self._cache.get(key)
        if not entry:
            return None
        expire_at, resp = entry
        if time.time() > expire_at:
            self._cache.pop(key, None)
            return None
        if resp is not None:
            resp.from_cache = True
        return resp

    def set(self, backend: str, query: str, count: int, resp: BackendResponse) -> None:
        """正缓存:成功响应,TTL 3600s。"""
        key = self._key(backend, query, count)
        self._cache[key] = (time.time() + self._ttl, resp)
        self._cache.move_to_end(key)
        self._evict()

    def set_negative(
        self, backend: str, query: str, count: int, resp: BackendResponse, ttl: int = 60
    ) -> None:
        """负缓存:失败响应,短 TTL 60s,避免改版期间高频无效请求。"""
        key = self._key(backend, query, count)
        self._cache[key] = (time.time() + ttl, resp)
        self._cache.move_to_end(key)
        self._evict()

    def _evict(self) -> None:
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)
```

---

### 3.5 可观测层：结构化日志 + 健康监控（P6）

#### 3.5.1 日志级别提升

```python
# base.py 改造:失败日志从 debug 提升到 warning
async def search(self, query: str, count: int) -> BackendResponse:
    url = self._build_url(query, count)
    try:
        html_text = await self._fetch_html(url)
    except Exception as e:
        logger.warning("{} 抓取失败: {}", self.name, e)  # debug → warning
        return BackendResponse(...)

    results = self._parse(html_text, count)
    if not results:
        logger.warning("{} 解析无结果(可能被风控或 HTML 改版)", self.name)  # debug → warning
        return BackendResponse(...)
```

#### 3.5.2 后端健康统计

```python
# miniUnicorn/agent/tools/web_search/backends/_health.py 新增

from collections import defaultdict, deque
from time import time


class BackendHealthMonitor:
    """后端健康统计:滑动窗口成功率,供 /health 端点暴露。"""
    _WINDOW = 100  # 最近 100 次
    _stats: dict[str, deque] = defaultdict(lambda: deque(maxlen=_WINDOW))

    @classmethod
    def record(cls, backend: str, success: bool) -> None:
        cls._stats[backend].append(1 if success else 0)

    @classmethod
    def snapshot(cls) -> dict[str, dict]:
        result = {}
        for backend, samples in cls._stats.items():
            if not samples:
                continue
            total = len(samples)
            success = sum(samples)
            result[backend] = {
                "success_rate": round(success / total, 3),
                "samples": total,
                "last_success": success > 0,
            }
        return result
```

#### 3.5.3 /health 端点扩展（可选）

```python
# miniUnicorn/api/server.py 改造 handle_health

async def handle_health(request):
    from miniUnicorn.agent.tools.web_search.backends._health import BackendHealthMonitor
    return web.json_response({
        "status": "ok",
        "web_search_backends": BackendHealthMonitor.snapshot(),
    })
```

---

### 3.6 回归测试体系（P8）

#### 3.6.1 目录结构

```
tests/
├── agent/
│   └── tools/
│       └── web_search/
│           ├── __init__.py
│           ├── test_backends.py          # 后端解析单元测试
│           ├── test_aggregator.py        # 聚合器重试/熔断测试
│           ├── test_cache.py             # 缓存(含负缓存)测试
│           ├── test_circuit_breaker.py   # 熔断器状态机测试
│           └── fixtures/
│               ├── baidu_2026_normal.html
│               ├── baidu_2026_captcha.html
│               ├── baidu_2026_gbk.html
│               ├── sogou_2026_normal.html
│               └── sogou_2026_captcha.html
```

#### 3.6.2 测试范式

```python
# tests/agent/tools/web_search/test_backends.py

import pytest
from pathlib import Path
from miniUnicorn.agent.tools.web_search.backends.baidu import BaiduBackend
from miniUnicorn.agent.tools.web_search.backends.config import WebSearchConfig

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def config():
    return WebSearchConfig()


@pytest.mark.parametrize("case,expected_count", [
    ("baidu_2026_normal.html", 5),       # 正常页面应解析出 5 条
    ("baidu_2026_captcha.html", 0),      # 风控页应返回 0 条
    ("baidu_2026_gbk.html", 5),          # GBK 编码应正确解码
])
def test_baidu_parse_robustness(config, case, expected_count):
    html = (FIXTURES / case).read_bytes().decode("utf-8", errors="replace")
    backend = BaiduBackend(config)
    results = backend._parse(html, 10)
    assert len(results) == expected_count
    if expected_count > 0:
        assert results[0].title
        assert results[0].url.startswith("http")


def test_baidu_multi_pattern_fallback(config):
    """主模式失效时,应回退到 JSON 提取模式。"""
    # 构造一个主正则匹配不到、但含 JSON 数据的 HTML
    html = '<html><body>{"title":"测试","url":"https://example.com","abstract":"摘要"}</body></html>'
    backend = BaiduBackend(config)
    results = backend._parse(html, 10)
    assert len(results) >= 1
    assert "测试" in results[0].title
```

```python
# tests/agent/tools/web_search/test_circuit_breaker.py

import pytest
from miniUnicorn.agent.tools.web_search.backends._circuit_breaker import BackendCircuitBreaker


def test_risk_control_triggers_immediate_block():
    BackendCircuitBreaker._state.clear()
    BackendCircuitBreaker.record_failure("baidu", is_risk_control=True)
    assert BackendCircuitBreaker.is_blocked("baidu")  # 风控立即熔断


def test_consecutive_failures_trigger_block():
    BackendCircuitBreaker._state.clear()
    for _ in range(3):
        BackendCircuitBreaker.record_failure("baidu")
    assert BackendCircuitBreaker.is_blocked("baidu")


def test_success_resets_counter():
    BackendCircuitBreaker._state.clear()
    BackendCircuitBreaker.record_failure("baidu")
    BackendCircuitBreaker.record_failure("baidu")
    BackendCircuitBreaker.record_success("baidu")
    assert not BackendCircuitBreaker.is_blocked("baidu")
```

#### 3.6.3 HTML Fixtures 采集脚本

```python
# scripts/collect_search_fixtures.py
"""定期采集真实搜索页面作为回归测试样本。

用法: python scripts/collect_search_fixtures.py
建议: 每月运行一次,或搜索后端失败时运行以捕获改版样本。
"""
import asyncio
import httpx
from pathlib import Path

FIXTURES_DIR = Path("tests/agent/tools/web_search/fixtures")
CASES = [
    ("baidu_2026_normal.html", "https://www.baidu.com/s?wd=Python&rn=10"),
    ("sogou_2026_normal.html", "https://www.sogou.com/web?query=Python&num=10"),
]


async def collect():
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    async with httpx.AsyncClient(timeout=30) as client:
        for filename, url in CASES:
            resp = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
            })
            (FIXTURES_DIR / filename).write_bytes(resp.content)
            print(f"采集 {filename}: {len(resp.content)} bytes")


if __name__ == "__main__":
    asyncio.run(collect())
```

---

## 四、实施计划

### 4.1 分阶段实施（按 ROI 排序）

| 阶段 | 内容 | 改动文件 | 预计代码量 | 风险 |
|---|---|---|---|---|
| **阶段1** | selectolax 依赖 + CSS 选择器解析 + 多模式链 | pyproject.toml、_html_utils.py、base.py、baidu.py、sogou.py | ~150 行 | 低(向后兼容) |
| **阶段2** | 编码探测 + UA 轮换 | _html_utils.py、base.py | ~50 行 | 低 |
| **阶段3** | 熔断器 + 重试 + 风控检测 | _circuit_breaker.py、_html_utils.py、aggregator.py | ~120 行 | 中(影响调度) |
| **阶段4** | 负缓存 | cache.py | ~30 行 | 低 |
| **阶段5** | 日志提升 + 健康监控 | base.py、_health.py、server.py | ~50 行 | 低 |
| **阶段6** | 回归测试 + fixtures 采集 | tests/、scripts/ | ~200 行 | 无 |

### 4.2 验收标准

| 验收项 | 标准 |
|---|---|
| 向后兼容 | 现有 baidu/sogou 后端配置无需改动即可工作 |
| CSS 解析优先 | selectolax 可用时优先用 CSS 选择器,失败回退正则 |
| 多模式容错 | 主模式失效时,JSON 提取模式能兜底 |
| 风控识别 | 验证码页面返回 0 结果 + 触发熔断 |
| 重试生效 | 网络错误重试 1 次,风控不重试 |
| 负缓存 | parse failed 60s 内不重复请求 |
| 日志可观测 | 失败日志 warning 级,含后端名与失败原因 |
| 回归测试 | fixtures 测试通过,覆盖正常/风控/GBK 三种场景 |

### 4.3 回滚方案

- 阶段1-2 出问题：设置环境变量 `WEB_SEARCH_DISABLE_SELECTOLAX=1` 降级纯正则
- 阶段3 出问题：设置 `WEB_SEARCH_DISABLE_CIRCUIT_BREAKER=1` 关闭熔断
- 阶段4 出问题：`set_negative` 调用点加开关,默认关闭

---

## 五、配置扩展

### 5.1 WebSearchBackendConfig 新增字段

```python
# miniUnicorn/agent/tools/web_search/config.py 改造

@dataclass
class WebSearchBackendConfig:
    api_key: str = ""
    base_url: str = ""
    timeout: float = 30.0
    # 新增字段(均有默认值,向后兼容)
    retries: int = 1              # 单后端重试次数
    parser: str = "auto"          # auto / css / regex
    enable_circuit_breaker: bool = True
```

### 5.2 前端设置页（可选）

[WebSearchSettings.tsx](file:///Users/tuolaonainaiguomalu/MyProject/mini-Unicorn/webui/src/components/settings/sections/WebSearchSettings.tsx) 可新增"高级选项"折叠区,暴露：
- 解析器选择（auto/css/regex）
- 重试次数
- 熔断开关

默认折叠,不干扰普通用户。

---

## 六、风险与限制

### 6.1 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| selectolax 安装失败 | 阶段1 不可用 | try/except 降级纯正则,功能不丢 |
| CSS 选择器同样改版失效 | 阶段1 长期效果有限 | 多模式链 + 回归测试早发现 |
| 熔断器误判 | 阶段3 误跳过后端 | half_open 试探 + 可配置关闭 |
| 负缓存导致短时不可用 | 阶段4 改版恢复慢 | TTL 仅 60s,影响有限 |

### 6.2 无法根治的问题

- **搜索引擎彻底改 API**：baidu/sogou 若改为纯 JS 渲染,HTML 抓取方案失效,需转向官方 API 或 SearXNG
- **风控升级为 JS 挑战**：UA 轮换无效,需 headless 浏览器,超出本方案范围
- **HTML 结构完全重构**：所有模式均失效,需人工更新选择器,回归测试保证可发现

---

## 七、与长期演进的关系

本方案是"HTML 抓取后端的加固",不改变 mini-Unicorn 的整体搜索架构。长期演进路径：

```
短期(本方案): HTML 抓取鲁棒性加固
    ↓
中期: 新增 SearXNG 内置后端(自托管多引擎聚合)
    ↓
长期: Tavily/Brave 提升为内置后端(海外高质量补充)
```

本方案确保"国内零配置可用"这一核心优势不被改版/风控侵蚀,为中期 SearXNG 接入赢得时间窗口。

---

## 八、附录

### 8.1 文件改动清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `pyproject.toml` | 修改 | 新增 selectolax 依赖 |
| `miniUnicorn/agent/tools/web_search/backends/_html_utils.py` | 修改 | 新增 ParsePattern、parse_with_css、parse_with_regex、detect_encoding、detect_block_type |
| `miniUnicorn/agent/tools/web_search/backends/_circuit_breaker.py` | 新增 | BackendCircuitBreaker |
| `miniUnicorn/agent/tools/web_search/backends/_health.py` | 新增 | BackendHealthMonitor |
| `miniUnicorn/agent/tools/web_search/backends/base.py` | 修改 | HtmlScrapeBackend 改用多模式链 + 编码探测 + UA 轮换 |
| `miniUnicorn/agent/tools/web_search/backends/baidu.py` | 修改 | 定义 CSS + 正则 + JSON 三模式 |
| `miniUnicorn/agent/tools/web_search/backends/sogou.py` | 修改 | 定义 CSS + 正则双模式 |
| `miniUnicorn/agent/tools/web_search/aggregator.py` | 修改 | _search_single 加重试 + 熔断 + 负缓存 |
| `miniUnicorn/agent/tools/web_search/cache.py` | 修改 | 新增 set_negative 负缓存 |
| `miniUnicorn/agent/tools/web_search/config.py` | 修改 | WebSearchBackendConfig 新增字段 |
| `tests/agent/tools/web_search/` | 新增 | 测试目录 + fixtures |
| `scripts/collect_search_fixtures.py` | 新增 | fixtures 采集脚本 |

### 8.2 依赖变更

```diff
# pyproject.toml
[project]
dependencies = [
    "httpx>=0.28.0,<1.0.0",
    "ddgs>=9.5.5,<10.0.0",
    "loguru>=0.7.3,<1.0.0",
    "readability-lxml>=0.8.4,<1.0.0",
    "chardet>=3.0.2,<6.0.0",
+   "selectolax>=0.3.21,<1.0.0",
]
```
