"""deep_research 独立配置 schema。

挂在 ToolsConfig.deep_research,与 web_search 平级,便于独立升级维护。
"""

from __future__ import annotations

from pydantic import Field

from miniUnicorn.config.schema import Base


class DeepResearchConfig(Base):
    """deep_research 工具配置。"""

    enable: bool = True
    # 单次研究最多发起多少次搜索(Plan + Reflect 补充查询合计上限)
    max_queries: int = Field(default=5, ge=1, le=10)
    # 每次搜索返回多少条结果
    per_query_results: int = Field(default=5, ge=1, le=10)
    # Plan 阶段一次性生成多少条候选查询(<= max_queries)
    initial_queries: int = Field(default=3, ge=1, le=10)
    # 是否启用 Reflect 阶段(根据已有结果决定是否补充搜索)
    enable_reflect: bool = True
    # Reflect 阶段最多追加多少次搜索
    reflect_rounds: int = Field(default=1, ge=0, le=3)
    # 最终报告的最大 token 数
    write_max_tokens: int = Field(default=4096, ge=512, le=16384)
    # Plan/Reflect 步骤的 LLM 最大 token 数
    plan_max_tokens: int = Field(default=1024, ge=256, le=4096)
    # LLM 温度
    temperature: float = Field(default=0.3, ge=0.0, le=2.0)
    # 单次搜索结果包含的 snippet 最大字符数(超出截断)
    snippet_max_chars: int = Field(default=400, ge=50, le=2000)
    # 单次研究的超时秒数(整体)
    overall_timeout_s: int = Field(default=180, ge=30, le=600)
