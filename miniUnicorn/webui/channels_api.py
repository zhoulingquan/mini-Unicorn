"""Channel configuration REST helpers for the WebUI HTTP surface.

读取/更新 ``config.channels`` 中的 per-channel 配置。可用 channel 列表
通过 ``channels.registry.discover_all()`` 自动发现，无需手动维护。
"""

from __future__ import annotations

import inspect
import typing
from typing import Any, get_args, get_origin

from pydantic import ValidationError

from miniUnicorn.config.loader import load_config, save_config
from miniUnicorn.config.schema import Base, ChannelsConfig


class WebUIChannelsError(ValueError):
    """User-facing channel validation failure."""

    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


QueryParams = dict[str, list[str]]


def _query_first(query: QueryParams, key: str) -> str | None:
    values = query.get(key)
    return values[0] if values else None


def _query_first_alias(query: QueryParams, snake: str, camel: str) -> str | None:
    value = _query_first(query, snake)
    return _query_first(query, camel) if value is None else value


# 字段名包含这些关键字时，前端渲染为 password 输入框
_SECRET_NAME_HINTS = ("secret", "token", "password", "apikey", "api_key")


def _is_secret_field(name: str) -> bool:
    lower = name.lower()
    return any(hint in lower for hint in _SECRET_NAME_HINTS)


def _detect_field_type(name: str, annotation: Any) -> dict[str, Any]:
    """根据 pydantic 字段类型注解推断前端 UI 控件类型与选项。

    返回 dict 含 ``ui_type`` (text/password/number/boolean/list/select) 与可选的 ``options``。
    """
    origin = get_origin(annotation)
    args = get_args(annotation)

    # Optional[X] / Union[X, None] → 取非 None 的部分
    if origin is typing.Union:
        non_none = [a for a in args if a is not type(None)]
        if non_none:
            return _detect_field_type(name, non_none[0])

    # Literal["a", "b"] → select
    if origin is typing.Literal:
        opts = [str(a) for a in args]
        return {"ui_type": "select", "options": opts}

    # list[str] → list
    if origin in (list, tuple):
        return {"ui_type": "list"}

    # bool 必须在 int 之前判断（bool 是 int 的子类）
    if annotation is bool:
        return {"ui_type": "boolean"}

    if annotation in (int, float):
        return {"ui_type": "number"}

    if annotation is str:
        if _is_secret_field(name):
            return {"ui_type": "password"}
        return {"ui_type": "text"}

    # 兜底
    return {"ui_type": "text"}


def _extract_config_schema(cls: type) -> list[dict[str, Any]]:
    """从 Channel 模块中找到 Config 类（继承 Base，类名以 Config 结尾）并提取字段元数据。

    参考 QwenPaw：每个 Channel 都有对应的 pydantic Config 类定义字段结构，
    这里通过反射自动提取字段类型/默认值/必填/描述等元数据，供前端动态渲染表单。
    """
    module = inspect.getmodule(cls)
    if module is None:
        return []

    # 在 channel 模块中查找继承 Base 且类名以 Config 结尾的类
    config_cls: type[Base] | None = None
    for attr_name in dir(module):
        obj = getattr(module, attr_name, None)
        if (
            isinstance(obj, type)
            and issubclass(obj, Base)
            and obj is not Base
            and obj.__name__.endswith("Config")
        ):
            # 跳过子配置类（如 MochatMentionConfig、MochatGroupRule，名字不以 Config 结尾）
            config_cls = obj
            break

    if config_cls is None:
        return []

    schema: list[dict[str, Any]] = []
    for name, field in config_cls.model_fields.items():
        type_info = _detect_field_type(name, field.annotation)
        # 默认值处理：field.default 可能是 PydanticUndefined sentinel
        # （当字段只有 default_factory 时），此时调用 factory 取值
        from pydantic_core import PydanticUndefined

        default: Any = field.default
        if default is PydanticUndefined and field.default_factory is not None:
            try:
                default = field.default_factory()
            except Exception:
                default = None
        if default is PydanticUndefined:
            default = None
        # 序列化为 JSON 兼容类型
        if isinstance(default, (str, int, float, bool)) or default is None:
            serializable_default: Any = default
        elif isinstance(default, list):
            serializable_default = list(default)
        elif isinstance(default, dict):
            serializable_default = dict(default)
        else:
            serializable_default = str(default)

        schema.append({
            "name": name,
            "alias": field.alias or name,
            "label": name.replace("_", " ").title(),
            "ui_type": type_info["ui_type"],
            "options": type_info.get("options"),
            "required": field.is_required(),
            "default": serializable_default,
            "description": field.description or "",
            "secret": type_info["ui_type"] == "password",
        })

    return schema


def _channel_class_meta(cls: type) -> dict[str, Any]:
    """从 BaseChannel 子类提取展示用元数据（含 default_config 模板和 config_schema）。"""
    doc = (cls.__doc__ or "").strip().splitlines()[0] if cls.__doc__ else ""
    # 调用 channel 类的 default_config() classmethod 获取默认配置模板
    # 参考 nanobot 模式：每个 Channel 类都通过 default_config() 返回完整字段
    default_cfg: dict[str, Any] | None = None
    try:
        default_config_fn = getattr(cls, "default_config", None)
        if callable(default_config_fn):
            default_cfg = default_config_fn()
    except Exception:
        default_cfg = None
    # 自动提取 Config 类字段元数据，供前端动态渲染表单
    # 参考 QwenPaw Console：每个 channel 卡片展开后显示鉴权字段表单
    config_schema = _extract_config_schema(cls)
    return {
        "name": cls.name,
        "display_name": getattr(cls, "display_name", cls.name),
        "description": doc,
        "default_config": default_cfg,
        "config_schema": config_schema,
    }


def list_channels() -> dict[str, Any]:
    """返回所有可用 channel 及其当前配置。

    通过 ``discover_all()`` 枚举内置 + 插件 channel，再从
    ``config.channels`` 读取每个 channel 的当前配置 dict。
    未在 config 中显式配置的 channel 返回 ``config: null``。
    """
    from miniUnicorn.channels.registry import discover_all

    try:
        available = discover_all()
    except Exception:
        available = {}

    config = load_config()
    channels_cfg: ChannelsConfig = config.channels
    # ChannelsConfig 使用 extra="allow" 接受任意 channel 字段
    extras = getattr(channels_cfg, "__pydantic_extra__", {}) or {}

    items: list[dict[str, Any]] = []
    for name in sorted(available.keys()):
        # websocket 频道是 WebUI 服务器进程本身（承担静态资源 + WS + REST API），
        # 关闭它会让整个 WebUI 挂掉；在频道页面中隐藏，避免误操作。
        if name == "websocket":
            continue
        cls = available[name]
        meta = _channel_class_meta(cls)
        # 读取当前配置（可能为 dict 或 pydantic 对象）
        current = extras.get(name)
        if current is None:
            current = getattr(channels_cfg, name, None)
        if current is None:
            config_dict: dict[str, Any] | None = None
        elif isinstance(current, dict):
            config_dict = current
        else:
            # pydantic 对象 → dump
            model_dump = getattr(current, "model_dump", None)
            config_dict = model_dump(by_alias=True) if callable(model_dump) else None

        items.append({
            "name": name,
            "display_name": meta["display_name"],
            "description": meta["description"],
            "default_config": meta["default_config"],
            "config_schema": meta["config_schema"],
            "configured": config_dict is not None,
            "enabled": name in (config.channels.__pydantic_extra__ or {}) or hasattr(channels_cfg, name),
            "config": config_dict,
        })

    # 顶层 ChannelsConfig 公共字段
    top_level = {
        "send_progress": channels_cfg.send_progress,
        "send_tool_hints": channels_cfg.send_tool_hints,
        "show_reasoning": channels_cfg.show_reasoning,
        "extract_document_text": channels_cfg.extract_document_text,
        "send_max_retries": channels_cfg.send_max_retries,
        "transcription_provider": channels_cfg.transcription_provider,
        "transcription_language": channels_cfg.transcription_language,
    }

    return {
        "channels": items,
        "defaults": top_level,
        "requires_restart": False,
    }


def update_channel_config(query: QueryParams) -> dict[str, Any]:
    """更新单个 channel 的配置（JSON 字符串形式提交）。

    参数：
      - ``name``: channel 名称（必填）
      - ``config``: JSON 字符串，解析后存入 ``config.channels.<name>``
      - ``enabled``: 可选，"true"/"false" 控制是否启用
    """
    name = (_query_first(query, "name") or "").strip().lower()
    if not name:
        raise WebUIChannelsError("name is required")
    if name in {"send_progress", "send_tool_hints", "show_reasoning",
                "extract_document_text", "send_max_retries",
                "transcription_provider", "transcription_language"}:
        raise WebUIChannelsError(f"'{name}' is a reserved top-level field")

    config_json = _query_first_alias(query, "config", "channelConfig")

    config = load_config()
    channels_cfg: ChannelsConfig = config.channels
    extras = getattr(channels_cfg, "__pydantic_extra__", None)
    if extras is None:
        # ChannelsConfig 未开启 extra="allow" 的兜底（不应发生）
        raise WebUIChannelsError("channels config does not accept extra fields")

    if config_json is not None:
        import json

        try:
            parsed = json.loads(config_json)
        except json.JSONDecodeError as e:
            raise WebUIChannelsError(f"invalid config JSON: {e}") from None
        if not isinstance(parsed, dict):
            raise WebUIChannelsError("config must be a JSON object")
        extras[name] = parsed
    elif name not in extras:
        # 未配置该 channel 且未显式提交 config 时，使用 channel 类的 default_config()
        # 作为兜底，使 toggle 可以直接启用未配置的 channel。
        # 参考 nanobot：每个 Channel 类有 default_config() classmethod 返回完整字段。
        from miniUnicorn.channels.registry import discover_all

        try:
            available = discover_all()
        except Exception:
            available = {}
        cls = available.get(name)
        if cls is None:
            raise WebUIChannelsError(f"channel '{name}' is not registered")
        default_fn = getattr(cls, "default_config", None)
        if not callable(default_fn):
            raise WebUIChannelsError(f"channel '{name}' has no existing config to update")
        try:
            defaults = default_fn() or {}
        except Exception as e:
            raise WebUIChannelsError(
                f"channel '{name}' has no existing config and default_config failed: {e}"
            ) from e
        if not isinstance(defaults, dict):
            raise WebUIChannelsError(
                f"channel '{name}' default_config returned non-dict value"
            )
        extras[name] = defaults

    enabled_raw = _query_first(query, "enabled")
    if enabled_raw is not None:
        # enabled=false 时从 extras 中移除该 channel 配置
        if enabled_raw.strip().lower() in {"false", "0", "no", "off"}:
            extras.pop(name, None)
        # enabled=true 时，extras 中应已存在 config（由上方 config_json 或 default_config 写入）
        elif name not in extras:
            # 兜底：使用空 dict，确保后续 save 不丢失 enabled 标志
            extras[name] = {}

    try:
        save_config(config)
    except Exception as e:
        raise WebUIChannelsError(f"failed to save config: {e}") from e

    return {
        "ok": True,
        "name": name,
        "enabled": name in extras,
        "config": extras.get(name),
    }


def delete_channel_config(query: QueryParams) -> dict[str, Any]:
    """移除某个 channel 的配置。

    参数：
      - ``name``: channel 名称（必填）
    """
    name = (_query_first(query, "name") or "").strip().lower()
    if not name:
        raise WebUIChannelsError("name is required")

    config = load_config()
    channels_cfg: ChannelsConfig = config.channels
    extras = getattr(channels_cfg, "__pydantic_extra__", {}) or {}

    if name not in extras:
        raise WebUIChannelsError(f"channel '{name}' is not configured", status=404)

    extras.pop(name, None)
    try:
        save_config(config)
    except Exception as e:
        raise WebUIChannelsError(f"failed to save config: {e}") from e

    return {"ok": True, "name": name}
