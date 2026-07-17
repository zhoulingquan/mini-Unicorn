import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  MessageSquare,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  deleteChannelConfig,
  fetchChannels,
  updateChannelConfig,
} from "@/lib/api";
import type { ChannelFieldSchema, ChannelPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ChannelsViewProps {
  onBack: () => void;
  token: string;
}

/** 优先用 i18n 的 channelNames 映射，缺失时回退到后端 display_name。
 * 参考 QwenPaw Console 的 getChannelLabel 模式。 */
function useChannelDisplayName() {
  const { t } = useTranslation();
  return (ch: ChannelPayload): string => {
    const translated = t(`channels.channelNames.${ch.name}`, {
      defaultValue: "",
    });
    return translated || ch.display_name;
  };
}

/** 频道卡片副标题（描述）的 i18n helper。
 * 查找顺序：channels.channelDescriptions.{name} → 后端 ch.description */
function useChannelDescription() {
  const { t } = useTranslation();
  return (ch: ChannelPayload): string => {
    const translated = t(`channels.channelDescriptions.${ch.name}`, {
      defaultValue: "",
    });
    return translated || ch.description;
  };
}

/** 字段标签/描述的 i18n helper。
 * 查找顺序：channels.channelFields.{channelName}.{fieldName} →
 *           channels.channelFields._common.{fieldName} →
 *           回退到后端 field.label / field.description
 * 这样 enabled / allow_from 等公共字段只需在 _common 定义一次。 */
function useFieldLabels() {
  const { t } = useTranslation();
  return (channelName: string, field: ChannelFieldSchema): {
    label: string;
    description: string;
  } => {
    const labelKey = `channels.channelFields.${channelName}.${field.name}`;
    const labelFallbackKey = `channels.channelFields._common.${field.name}`;
    const translated = t(labelKey, { defaultValue: "" });
    const fallbackTranslated = t(labelFallbackKey, { defaultValue: "" });
    const label =
      translated || fallbackTranslated || field.label;

    const descKey = `channels.channelFields.${channelName}.${field.name}_desc`;
    const descFallbackKey = `channels.channelFields._common.${field.name}_desc`;
    const descTranslated = t(descKey, { defaultValue: "" });
    const descFallbackTranslated = t(descFallbackKey, {
      defaultValue: "",
    });
    const description =
      descTranslated || descFallbackTranslated || field.description;

    return { label, description };
  };
}

/** 字段名 → 字段值（已按字段类型转换）。 */
type FormValues = Record<string, unknown>;

/** 初始化某个 channel 的表单值：优先 config，其次 default_config，最后字段 default。 */
function initFormValues(ch: ChannelPayload): FormValues {
  const base = (ch.config ?? ch.default_config ?? {}) as Record<string, unknown>;
  const values: FormValues = {};
  for (const f of ch.config_schema ?? []) {
    values[f.name] = f.name in base ? base[f.name] : f.default;
  }
  return values;
}

/** list 字段 ↔ 多行字符串草稿互转（每行一项）。 */
function listToDraft(value: unknown): string {
  return Array.isArray(value) ? value.join("\n") : "";
}

function draftToList(draft: string): string[] {
  return draft
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 比较两个值是否相等（list 走逐项比较）。 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

export function ChannelsView({ onBack, token }: ChannelsViewProps) {
  const { t } = useTranslation();
  const getDisplayName = useChannelDisplayName();
  const getDescription = useChannelDescription();
  const getFieldLabels = useFieldLabels();
  const [channels, setChannels] = useState<ChannelPayload[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  // 每个 channel 的表单值
  const [formValues, setFormValues] = useState<Record<string, FormValues>>({});
  // list 字段的多行字符串草稿（key: `${channelName}.${fieldName}`）
  const [listDrafts, setListDrafts] = useState<Record<string, string>>({});
  const [actingName, setActingName] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchChannels(token);
      setChannels(data.channels);
      const initialForms: Record<string, FormValues> = {};
      for (const ch of data.channels) {
        initialForms[ch.name] = initFormValues(ch);
      }
      setFormValues(initialForms);
      setListDrafts({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const getFormValues = (ch: ChannelPayload): FormValues =>
    formValues[ch.name] ?? initFormValues(ch);

  // 判断 channel 表单是否有改动
  const isDirty = (ch: ChannelPayload): boolean => {
    if (!ch.config_schema || ch.config_schema.length === 0) return false;
    const current = getFormValues(ch);
    const original = (ch.config ?? ch.default_config ?? {}) as Record<string, unknown>;
    for (const f of ch.config_schema) {
      const cur = current[f.name];
      const orig = f.name in original ? original[f.name] : f.default;
      if (!valuesEqual(cur, orig)) return true;
    }
    return false;
  };

  const handleToggleEnabled = async (ch: ChannelPayload) => {
    if (actingName) return;
    setActingName(ch.name);
    try {
      // 启用未配置 channel 时，前端先以 default_config 作为 payload 提交，
      // 与后端兜底（default_config()）保持一致，避免 "no existing config" 错误。
      const nextEnabled = !ch.enabled;
      const configPayload =
        nextEnabled && !ch.config ? ch.default_config : ch.config;
      await updateChannelConfig(token, ch.name, configPayload, nextEnabled);
      setChannels((prev) =>
        prev.map((c) =>
          c.name === ch.name
            ? {
                ...c,
                enabled: nextEnabled,
                config:
                  nextEnabled && !c.config && c.default_config
                    ? c.default_config
                    : c.config,
                configured:
                  nextEnabled && !c.config ? Boolean(c.default_config) : c.configured,
              }
            : c,
        ),
      );
      setFormValues((prev) => ({ ...prev, [ch.name]: initFormValues(ch) }));
      setToast(t("channels.toast.toggled", { name: getDisplayName(ch) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActingName(null);
    }
  };

  const handleFieldChange = (
    ch: ChannelPayload,
    fieldName: string,
    value: unknown,
  ) => {
    setFormValues((prev) => ({
      ...prev,
      [ch.name]: {
        ...(prev[ch.name] ?? initFormValues(ch)),
        [fieldName]: value,
      },
    }));
  };

  const handleListChange = (
    ch: ChannelPayload,
    fieldName: string,
    draft: string,
  ) => {
    const key = `${ch.name}.${fieldName}`;
    setListDrafts((prev) => ({ ...prev, [key]: draft }));
    handleFieldChange(ch, fieldName, draftToList(draft));
  };

  const getListDraft = (ch: ChannelPayload, fieldName: string): string => {
    const key = `${ch.name}.${fieldName}`;
    if (key in listDrafts) return listDrafts[key];
    return listToDraft(getFormValues(ch)[fieldName]);
  };

  const handleSave = async (ch: ChannelPayload) => {
    if (actingName || !isDirty(ch)) return;
    setActingName(ch.name);
    try {
      const values = getFormValues(ch);
      // 构造 alias-keyed payload（后端 Config 类同时支持 snake/camel）
      const payload: Record<string, unknown> = {};
      for (const f of ch.config_schema ?? []) {
        payload[f.alias] = values[f.name];
      }
      await updateChannelConfig(token, ch.name, payload, ch.enabled);
      setChannels((prev) =>
        prev.map((c) =>
          c.name === ch.name ? { ...c, config: payload, configured: true } : c,
        ),
      );
      setFormValues((prev) => ({ ...prev, [ch.name]: { ...values } }));
      setToast(t("channels.toast.saved", { name: getDisplayName(ch) }));
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setActingName(null);
    }
  };

  const handleDelete = async (ch: ChannelPayload) => {
    if (actingName) return;
    setActingName(ch.name);
    try {
      await deleteChannelConfig(token, ch.name);
      setChannels((prev) =>
        prev.map((c) =>
          c.name === ch.name
            ? { ...c, config: null, configured: false, enabled: false }
            : c,
        ),
      );
      // 重置该 channel 的表单值为默认（未配置状态）
      setFormValues((prev) => {
        const next = { ...prev };
        // 用 config=null 重新初始化
        const reset = initFormValues({ ...ch, config: null });
        next[ch.name] = reset;
        return next;
      });
      setListDrafts((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k) => {
          if (k.startsWith(`${ch.name}.`)) delete next[k];
        });
        return next;
      });
      setToast(t("channels.toast.deleted", { name: getDisplayName(ch) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActingName(null);
    }
  };

  /** 渲染单个字段的表单控件。 */
  const renderField = (ch: ChannelPayload, field: ChannelFieldSchema) => {
    const values = getFormValues(ch);
    const value = values[field.name];
    const disabled = actingName === ch.name;
    const { label, description } = getFieldLabels(ch.name, field);

    // 标签：label + 必填星号 + 描述
    const labelEl = (
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground/90">
          {label}
          {field.required ? (
            <span className="ml-0.5 text-destructive">*</span>
          ) : null}
        </span>
        {description ? (
          <span className="text-[10px] text-muted-foreground/60">
            · {description}
          </span>
        ) : null}
      </div>
    );

    switch (field.ui_type) {
      case "boolean":
        return (
          <div
            key={field.name}
            className="flex items-center justify-between gap-3 py-1"
          >
            {labelEl}
            <ToggleSwitch
              checked={Boolean(value)}
              disabled={disabled}
              onClick={() => handleFieldChange(ch, field.name, !value)}
              ariaLabel={field.label}
            />
          </div>
        );

      case "select":
        return (
          <div key={field.name} className="space-y-1">
            {labelEl}
            <select
              value={String(value ?? "")}
              onChange={(e) => handleFieldChange(ch, field.name, e.target.value)}
              disabled={disabled}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {(field.options ?? []).map((opt) => {
                // select 选项翻译：channels.channelFields._options.{field_name}_{opt}
                const optLabel = t(
                  `channels.channelFields._options.${field.name}_${opt}`,
                  { defaultValue: opt }
                );
                return (
                  <option key={opt} value={opt}>
                    {optLabel}
                  </option>
                );
              })}
            </select>
          </div>
        );

      case "list":
        return (
          <div key={field.name} className="space-y-1">
            {labelEl}
            <Textarea
              value={getListDraft(ch, field.name)}
              onChange={(e) =>
                handleListChange(ch, field.name, e.target.value)
              }
              disabled={disabled}
              placeholder={t("channels.listPlaceholder")}
              className="min-h-[60px] resize-y font-mono text-xs"
              spellCheck={false}
            />
          </div>
        );

      case "number":
        return (
          <div key={field.name} className="space-y-1">
            {labelEl}
            <Input
              type="number"
              value={
                value === null || value === undefined ? "" : String(value)
              }
              onChange={(e) => {
                const v = e.target.value;
                handleFieldChange(
                  ch,
                  field.name,
                  v === "" ? null : Number(v),
                );
              }}
              disabled={disabled}
              className="h-9 text-sm"
            />
          </div>
        );

      case "password":
        return (
          <div key={field.name} className="space-y-1">
            {labelEl}
            <Input
              type="password"
              value={String(value ?? "")}
              onChange={(e) =>
                handleFieldChange(ch, field.name, e.target.value)
              }
              disabled={disabled}
              autoComplete="off"
              placeholder={field.secret ? "••••••••" : ""}
              className="h-9 text-sm"
            />
          </div>
        );

      case "text":
      default:
        return (
          <div key={field.name} className="space-y-1">
            {labelEl}
            <Input
              type="text"
              value={String(value ?? "")}
              onChange={(e) =>
                handleFieldChange(ch, field.name, e.target.value)
              }
              disabled={disabled}
              className="h-9 text-sm"
            />
          </div>
        );
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4.5 w-4.5 text-foreground/80" />
          <h1 className="text-sm font-semibold">{t("channels.title")}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={load}
            disabled={loading}
            title={t("channels.refresh")}
            aria-label={t("channels.refresh")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <AlertCircle className="h-6 w-6 opacity-50" />
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              {t("channels.retry")}
            </Button>
          </div>
        ) : loading && channels.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("channels.loading")}
          </div>
        ) : channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 opacity-40" />
            <p>{t("channels.empty")}</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-2.5">
            {channels.map((ch) => {
              const expanded = expandedName === ch.name;
              const dirty = isDirty(ch);
              const schema = ch.config_schema ?? [];
              return (
                <div
                  key={ch.name}
                  className="rounded-xl border bg-card text-card-foreground shadow-sm transition-colors hover:bg-accent/20"
                >
                  <div className="flex items-center gap-3 px-3.5 py-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      onClick={() =>
                        setExpandedName(expanded ? null : ch.name)
                      }
                      aria-expanded={expanded}
                    >
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                          expanded && "rotate-90",
                        )}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {getDisplayName(ch)}
                          </span>
                          {ch.configured ? (
                            <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
                              {t("channels.badge.configured")}
                            </span>
                          ) : (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {t("channels.badge.unconfigured")}
                            </span>
                          )}
                        </div>
                        {getDescription(ch) ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {getDescription(ch)}
                          </span>
                        ) : null}
                      </div>
                    </button>
                    <ToggleSwitch
                      checked={ch.enabled}
                      disabled={actingName === ch.name}
                      onClick={() => handleToggleEnabled(ch)}
                      ariaLabel={t("channels.toggle.aria", {
                        name: getDisplayName(ch),
                      })}
                    />
                  </div>
                  {expanded && schema.length > 0 ? (
                    <div className="flex flex-col gap-2.5 border-t bg-background/40 px-3.5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs font-medium text-muted-foreground">
                          {t("channels.configLabel")}
                        </label>
                        {!ch.configured ? (
                          <span className="text-[10px] text-muted-foreground/70">
                            {t("channels.defaultHint")}
                          </span>
                        ) : null}
                      </div>
                      {schema.map((field) => renderField(ch, field))}
                      <div className="mt-1 flex items-center gap-2">
                        <Button
                          variant="default"
                          size="sm"
                          className="h-7 gap-1.5"
                          onClick={() => handleSave(ch)}
                          disabled={actingName === ch.name || !dirty}
                        >
                          {actingName === ch.name ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Save className="h-3.5 w-3.5" />
                          )}
                          {t("channels.save")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5"
                          onClick={() => handleDelete(ch)}
                          disabled={actingName === ch.name || !ch.configured}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("channels.delete")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {toast ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border/70 bg-popover px-4 py-2 text-xs font-medium text-popover-foreground shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
