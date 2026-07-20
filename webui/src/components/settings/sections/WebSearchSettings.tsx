// Web Search section:web_search 工具配置(后端、降级链、缓存、代理、API Key)

import { useMemo, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import type { WebSearchSettingsUpdate } from "@/lib/types";

import { NumberInput, SegmentedControl, ToggleButton } from "../components/SegmentedControl";
import { RestartSettingsFooter } from "../components/RestartSettingsFooter";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  ClearableInput,
} from "../components/SettingsRow";

// 可选后端清单(与后端 web_search/config.py 保持一致)
const PROVIDER_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "bing_cn", label: "Bing" },
  { value: "bocha", label: "Bocha" },
  { value: "sogou", label: "Sogou" },
  { value: "baidu", label: "Baidu" },
  { value: "tencent", label: "Tencent" },
  { value: "duckduckgo", label: "DuckDuckGo" },
];

// 可配置 API Key 的后端(只有这些需要在 UI 展示卡片)
const KEYED_BACKENDS = ["bocha", "tencent", "duckduckgo"];

export function WebSearchSettings({
  form,
  dirty,
  saving,
  requiresRestartPending,
  onChangeForm,
  onSave,
  onRestart,
  isRestarting,
}: {
  form: WebSearchSettingsUpdate;
  dirty: boolean;
  saving: boolean;
  requiresRestartPending: boolean;
  onChangeForm: Dispatch<SetStateAction<WebSearchSettingsUpdate>>;
  onRestart?: () => void;
  isRestarting?: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  // 后端卡片需要的所有 backend 都展示,缺失的补上空草稿,便于用户填写
  const backendEntries = useMemo(() => {
    const result: Array<{ name: string; draft: WebSearchSettingsUpdate["backends"][string] }> = [];
    for (const name of KEYED_BACKENDS) {
      const draft = form.backends[name] ?? { api_key: "", base_url: "", timeout: 30 };
      result.push({ name, draft });
    }
    // 额外展示用户已配置但不在 KEYED_BACKENDS 列表中的后端
    for (const [name, draft] of Object.entries(form.backends)) {
      if (!KEYED_BACKENDS.includes(name)) {
        result.push({ name, draft });
      }
    }
    return result;
  }, [form.backends]);

  const setField = <K extends keyof WebSearchSettingsUpdate>(
    key: K,
    value: WebSearchSettingsUpdate[K],
  ) => {
    onChangeForm((prev) => ({ ...prev, [key]: value }));
  };

  const setBackendField = (
    backendName: string,
    field: "api_key" | "base_url" | "timeout",
    value: string | number,
  ) => {
    onChangeForm((prev) => {
      const existing = prev.backends[backendName] ?? { api_key: "", base_url: "", timeout: 30 };
      return {
        ...prev,
        backends: {
          ...prev.backends,
          [backendName]: { ...existing, [field]: value },
        },
      };
    });
  };

  return (
    <div className="space-y-7">
      {/* 基础设置 */}
      <section>
        <SettingsSectionTitle>
          {tx("settings.sections.webSearchBasic", "Web Search")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.webSearchEnable", "Enable web_search")}
            description={tx(
              "settings.help.webSearchEnable",
              "Toggle the web_search tool on/off for the agent.",
            )}
          >
            <ToggleButton
              checked={form.enable}
              onChange={(v) => setField("enable", v)}
              ariaLabel={tx("settings.rows.webSearchEnable", "Enable web_search")}
              label={form.enable ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webSearchProvider", "Backend")}
            description={tx(
              "settings.help.webSearchProvider",
              "auto = use fallback chain by region. Explicit name = use only that backend.",
            )}
          >
            <select
              value={form.provider}
              onChange={(e) => setField("provider", e.target.value)}
              className="h-8 rounded-full border border-border/60 bg-background px-3 text-[13px] focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webSearchRegion", "Region")}
            description={tx(
              "settings.help.webSearchRegion",
              "cn = domestic fallback chain (default). global = overseas chain (proxy required for some backends).",
            )}
          >
            <SegmentedControl
              value={form.region}
              options={[
                { value: "cn", label: tx("settings.values.cnRegion", "CN") },
                { value: "global", label: tx("settings.values.globalRegion", "Global") },
              ]}
              onChange={(v) => setField("region", v)}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webSearchMaxResults", "Max results")}
            description={tx(
              "settings.help.webSearchMaxResults",
              "Maximum number of results returned per query (1-10).",
            )}
          >
            <NumberInput
              value={form.max_results}
              min={1}
              max={10}
              onChange={(v) => setField("max_results", v)}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webSearchTimeout", "Timeout")}
            description={tx(
              "settings.help.webSearchTimeout",
              "Per-request timeout in seconds.",
            )}
          >
            <NumberInput
              value={form.timeout}
              min={5}
              max={120}
              onChange={(v) => setField("timeout", v)}
              suffix={tx("settings.values.seconds", "s")}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* 缓存与代理 */}
      <section>
        <SettingsSectionTitle>
          {tx("settings.sections.webSearchCache", "Cache & Network")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.webSearchCache", "Result cache")}
            description={tx(
              "settings.help.webSearchCache",
              "Cache search results to avoid duplicate requests within TTL.",
            )}
          >
            <ToggleButton
              checked={form.enable_cache}
              onChange={(v) => setField("enable_cache", v)}
              ariaLabel={tx("settings.rows.webSearchCache", "Result cache")}
              label={form.enable_cache ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webSearchCacheTtl", "Cache TTL")}
            description={tx(
              "settings.help.webSearchCacheTtl",
              "Time-to-live for cached results in seconds.",
            )}
          >
            <NumberInput
              value={form.cache_ttl}
              min={60}
              max={86400}
              onChange={(v) => setField("cache_ttl", v)}
              suffix={tx("settings.values.seconds", "s")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webSearchProxy", "Proxy")}
            description={tx(
              "settings.help.webSearchProxy",
              "HTTP proxy for overseas backends (e.g. duckduckgo). Leave empty to use system env.",
            )}
          >
            <ClearableInput
              value={form.proxy}
              onChange={(e) => setField("proxy", e.target.value)}
              onClear={() => setField("proxy", "")}
              placeholder="http://127.0.0.1:7890"
              className="h-8 w-72 rounded-full text-[13px]"
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webSearchUserAgent", "User-Agent")}
            description={tx(
              "settings.help.webSearchUserAgent",
              "Custom User-Agent for scraping backends. Leave empty to use default.",
            )}
          >
            <ClearableInput
              value={form.user_agent}
              onChange={(e) => setField("user_agent", e.target.value)}
              onClear={() => setField("user_agent", "")}
              placeholder=""
              className="h-8 w-72 rounded-full text-[13px]"
            />
          </SettingsRow>
        </SettingsGroup>
      </section>

      {/* 后端 API Key 配置 */}
      <section>
        <SettingsSectionTitle>
          {tx("settings.sections.webSearchBackends", "Backend Credentials")}
        </SettingsSectionTitle>
        <SettingsGroup>
          {backendEntries.map(({ name, draft }) => (
            <div
              key={name}
              className="flex flex-col gap-3 px-4 py-3.5 sm:px-5"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[14px] font-medium leading-5 text-foreground">{name}</div>
                  <div className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
                    {tx(`settings.help.webSearchBackend_${name}`, backendHelpFallback(name))}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <ClearableInput
                  value={draft.api_key}
                  onChange={(e) => setBackendField(name, "api_key", e.target.value)}
                  onClear={() => setBackendField(name, "api_key", "")}
                  placeholder={tx("settings.rows.webSearchApiKey", "API Key")}
                  className="h-8 w-56 rounded-full text-[13px]"
                />
                <ClearableInput
                  value={draft.base_url}
                  onChange={(e) => setBackendField(name, "base_url", e.target.value)}
                  onClear={() => setBackendField(name, "base_url", "")}
                  placeholder={tx("settings.rows.webSearchBaseUrl", "Base URL (optional)")}
                  className="h-8 w-56 rounded-full text-[13px]"
                />
                <NumberInput
                  value={draft.timeout}
                  min={5}
                  max={120}
                  onChange={(v) => setBackendField(name, "timeout", v)}
                  suffix={tx("settings.values.seconds", "s")}
                />
              </div>
            </div>
          ))}
        </SettingsGroup>
      </section>

      <RestartSettingsFooter
        dirty={dirty}
        saving={saving}
        pendingRestart={requiresRestartPending}
        onSave={onSave}
        onRestart={onRestart}
        isRestarting={isRestarting}
      />
    </div>
  );
}

function backendHelpFallback(name: string): string {
  switch (name) {
    case "bocha":
      return "Bocha AI Search API (CN, requires key, free tier available)";
    case "tencent":
      return "Tencent Cloud Search (CN, requires secret_id:secret_key)";
    case "duckduckgo":
      return "DuckDuckGo (overseas, no key, requires proxy in CN)";
    default:
      return "";
  }
}
