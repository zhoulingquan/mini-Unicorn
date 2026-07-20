"""独立 web_search 模块。

与 web_fetch 解耦,负责关键词搜索,聚合多家搜索引擎后端。
- 国内零配置可用(bing_cn/baidu/sogou 免 Key 抓取)
- 国内 API 后端(bocha/tencent)
- 国外免 Key 后端(duckduckgo,需代理)
- 国外 API 后端(brave/tavily)通过 MCP presets 提供,不在此实现

详见 `tool.py` 的 WebSearchTool。
"""

from miniUnicorn.agent.tools.web_search.tool import WebSearchTool

__all__ = ["WebSearchTool"]
