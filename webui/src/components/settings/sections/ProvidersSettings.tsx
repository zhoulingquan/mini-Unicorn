// Providers section:已配置/未配置两个分组,每个 provider 卡片支持
// API Key / API Base / Model 编辑、OAuth 登录登出、删除、模型列表抓取。
// 从 SettingsView.tsx 拆分而来。

import { useMemo } from "react";
import {
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { SettingsPayload } from "@/lib/types";

import {
  OPENAI_API_TYPE_OPTIONS,
  orderUnconfiguredProviders,
  type ProviderForm,
} from "../types";
import { ClearableInput, StatusPill } from "../components/SettingsRow";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderSection } from "../components/ProviderSection";

export function ProvidersSettings({
  settings,
  expandedProvider,
  providerForms,
  visibleProviderKeys,
  editingProviderKeys,
  providerSaving,
  providerSaved,
  providerModels,
  providerModelsLoading,
  learningProvider,
  timeoutProvider,
  showBrandLogos,
  onToggleProvider,
  onToggleProviderKey,
  onToggleProviderKeyEditing,
  onChangeProviderForm,
  onSaveProvider,
  onFetchProviderModels,
  onProviderOAuthLogin,
  onProviderOAuthLogout,
  onRequestDeleteProvider,
  customPresetLabel,
  onChangeCustomPresetLabel,
  onSaveCustomConfiguration,
}: {
  settings: SettingsPayload;
  expandedProvider: string | null;
  providerForms: Record<string, ProviderForm>;
  visibleProviderKeys: Record<string, boolean>;
  editingProviderKeys: Record<string, boolean>;
  providerSaving: string | null;
  providerSaved: Record<string, boolean>;
  providerModels: Record<string, string[]>;
  providerModelsLoading: string | null;
  learningProvider: string | null;
  timeoutProvider: string | null;
  showBrandLogos: boolean;
  onToggleProvider: (provider: string) => void;
  onToggleProviderKey: (provider: string) => void;
  onToggleProviderKeyEditing: (provider: string) => void;
  onChangeProviderForm: (provider: string, value: Partial<ProviderForm>) => void;
  onSaveProvider: (provider: string) => void;
  onFetchProviderModels: (provider: string) => void;
  onProviderOAuthLogin: (provider: string) => void;
  onProviderOAuthLogout: (provider: string) => void;
  onRequestDeleteProvider: (provider: string) => void;
  customPresetLabel: string;
  onChangeCustomPresetLabel: (value: string) => void;
  onSaveCustomConfiguration: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  // custom preset 虚拟条目(name=custom__xxx)configured=true,会自动进入已配置区域。
  // 真正的 "custom" 单例 configured=false,作为未配置区域的添加入口。
  const configuredProviders = useMemo(
    () => settings.providers.filter((provider) => provider.configured),
    [settings.providers],
  );
  const unconfiguredProviders = useMemo(
    () => orderUnconfiguredProviders(settings.providers.filter((provider) => !provider.configured)),
    [settings.providers],
  );
  const renderProviderRow = (provider: SettingsPayload["providers"][number]) => {
    const expanded = expandedProvider === provider.name;
    const form = providerForms[provider.name] ?? {
      apiKey: "",
      apiBase: provider.api_base ?? provider.default_api_base ?? "",
      apiType: provider.api_type ?? "auto",
      model: "",
    };
    const saving = providerSaving === provider.name;
    const saved = !!providerSaved[provider.name];
    const modelsLoading = providerModelsLoading === provider.name;
    const fetchedModels = providerModels[provider.name] ?? [];
    const isOauthProvider = provider.auth_type === "oauth";
    const keyVisible = !!visibleProviderKeys[provider.name];
    const editingKey = !provider.configured || !!editingProviderKeys[provider.name];
    const apiKeyRequired = provider.api_key_required ?? true;
    const apiKey = form.apiKey.trim();
    const apiBase = form.apiBase.trim();
    const missingRequiredApiKey = !isOauthProvider && apiKeyRequired && !provider.configured && !apiKey;
    const missingOptionalCredential =
      !isOauthProvider && !apiKeyRequired && !provider.configured && !apiKey && !apiBase;
    return (
      <div key={provider.name} className="divide-y divide-border/45">
        <button
          type="button"
          onClick={() => onToggleProvider(provider.name)}
          className="flex min-h-[70px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5"
        >
          <span className="flex min-w-0 items-center gap-3">
            <ProviderIcon
              provider={provider.name}
              showBrandLogos={showBrandLogos}
              label={provider.label}
            />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold leading-5 text-foreground">
                {provider.label}
              </span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {provider.api_base || provider.default_api_base || provider.name}
              </span>
            </span>
          </span>
          <StatusPill tone={provider.configured ? "success" : "neutral"}>
            {isOauthProvider
              ? provider.configured
                ? tx("settings.oauth.signedIn", "Signed in")
                : tx("settings.oauth.notSignedIn", "Not signed in")
              : provider.configured
                ? t("settings.byok.configured")
                : t("settings.byok.notConfigured")}
          </StatusPill>
        </button>

        {expanded ? (
          <div className="space-y-3 bg-muted/18 px-4 py-4 sm:px-5">
            {isOauthProvider ? (
              <div className="flex flex-col gap-3 rounded-[18px] border border-border/45 bg-background/75 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-foreground">
                    {tx("settings.oauth.authentication", "OAuth authentication")}
                  </p>
                  <p className="mt-1 truncate text-[12px] text-muted-foreground">
                    {provider.configured
                      ? t("settings.oauth.signedInAs", {
                          account: provider.oauth_account || provider.label,
                          defaultValue: "Signed in as {{account}}",
                        })
                      : tx("settings.oauth.signInHelp", "Sign in from this device; no API key is stored in config.")}
                  </p>
                </div>
                <div className="flex shrink-0 justify-end gap-2">
                  {provider.configured ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onProviderOAuthLogout(provider.name)}
                      disabled={saving}
                      className="rounded-full"
                    >
                      {tx("settings.oauth.signOut", "Sign out")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onProviderOAuthLogin(provider.name)}
                    disabled={saving || !provider.oauth_login_supported}
                    className="rounded-full"
                  >
                    {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                    {saving
                      ? tx("settings.oauth.signingIn", "Signing in...")
                      : provider.configured
                        ? tx("settings.oauth.signInAgain", "Sign in again")
                        : tx("settings.oauth.signIn", "Sign in")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
            {/* custom provider:配置名称(每个 custom 配置是独立 model_preset,label 用于区分) */}
            {provider.name === "custom" ? (
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">
                  {tx("settings.byok.customLabel", "Label")}
                </span>
                <ClearableInput
                  value={customPresetLabel}
                  onChange={(event) => onChangeCustomPresetLabel(event.target.value)}
                  onClear={() => onChangeCustomPresetLabel("")}
                  placeholder={tx("settings.byok.customLabelPlaceholder", "e.g. agnes, my-service")}
                  className="h-9 rounded-full text-[13px]"
                />
              </label>
            ) : null}
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiKey")}
              </span>
              <div className="relative">
                {editingKey ? (
                  <ClearableInput
                    type={keyVisible ? "text" : "password"}
                    value={form.apiKey}
                    onChange={(event) =>
                      onChangeProviderForm(provider.name, { apiKey: event.target.value })
                    }
                    onClear={() => onChangeProviderForm(provider.name, { apiKey: "" })}
                    placeholder={
                      provider.configured
                        ? t("settings.byok.apiKeyConfiguredPlaceholder")
                        : t("settings.byok.apiKeyPlaceholder")
                    }
                    className="h-9 rounded-full text-[13px]"
                    trailingSlot={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => onToggleProviderKey(provider.name)}
                        aria-label={
                          keyVisible
                            ? t("settings.byok.hideApiKey")
                            : t("settings.byok.showApiKey")
                        }
                        className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {keyVisible ? (
                          <EyeOff className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                        )}
                      </Button>
                    }
                  />
                ) : (
                  <>
                    <div className="flex h-9 items-center rounded-full border border-input bg-background px-3 pr-11 text-[13px] text-muted-foreground">
                      {provider.api_key_hint ?? t("settings.byok.configuredKeyHint")}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onToggleProviderKeyEditing(provider.name)}
                      aria-label={t("settings.actions.edit")}
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiBase")}
              </span>
              <ClearableInput
                value={form.apiBase}
                onChange={(event) =>
                  onChangeProviderForm(provider.name, { apiBase: event.target.value })
                }
                onClear={() => onChangeProviderForm(provider.name, { apiBase: "" })}
                placeholder={provider.default_api_base ?? t("settings.byok.apiBasePlaceholder")}
                className="h-9 rounded-full text-[13px]"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                {tx("settings.byok.modelId", "Model ID")}
              </span>
              <div className="flex gap-2">
                <ClearableInput
                  value={form.model}
                  onChange={(event) =>
                    onChangeProviderForm(provider.name, { model: event.target.value })
                  }
                  onClear={() => onChangeProviderForm(provider.name, { model: "" })}
                  placeholder={tx("settings.byok.modelIdPlaceholder", "e.g. gpt-4o, deepseek-chat")}
                  className="h-9 flex-1 rounded-full text-[13px]"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onFetchProviderModels(provider.name)}
                  disabled={modelsLoading}
                  className="h-9 shrink-0 rounded-full px-3 text-[12px]"
                >
                  {modelsLoading ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <Search className="mr-1 h-3 w-3" aria-hidden />
                  )}
                  {modelsLoading
                    ? tx("settings.byok.fetchingModels", "Fetching...")
                    : tx("settings.byok.fetchModels", "Fetch models")}
                </Button>
              </div>
              <span className="block text-[11px] text-muted-foreground/80">
                {tx("settings.byok.modelIdHelp", "Set as active model when saving.")}
              </span>
              {fetchedModels.length > 0 ? (
                <div className="mt-1 max-h-[160px] overflow-y-auto rounded-lg border border-border/45 bg-background/60">
                  {fetchedModels.map((modelId) => (
                    <button
                      key={modelId}
                      type="button"
                      onClick={() => onChangeProviderForm(provider.name, { model: modelId })}
                      className={cn(
                        "block w-full truncate px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-muted/50",
                        form.model === modelId
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground",
                      )}
                      title={modelId}
                    >
                      {modelId}
                    </button>
                  ))}
                </div>
              ) : null}
            </label>
            {provider.name === "openai" ? (
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-muted-foreground">
                  {tx("settings.byok.apiType", "API type")}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 w-full justify-between rounded-full px-3 text-[13px]"
                    >
                      <span>
                        {OPENAI_API_TYPE_OPTIONS.find((option) => option.value === form.apiType)?.label ??
                          form.apiType}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[220px]">
                    {OPENAI_API_TYPE_OPTIONS.map((option) => (
                      <DropdownMenuItem
                        key={option.value}
                        onSelect={() => onChangeProviderForm(provider.name, { apiType: option.value })}
                      >
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </label>
            ) : null}
            {provider.name === "custom" &&
              (!customPresetLabel.trim() ||
                !form.apiBase.trim() ||
                !form.model.trim()) ? (
              <p className="text-right text-[11px] text-muted-foreground">
                {tx("settings.byok.customRequiredHint", "Label, API base and model are required")}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  provider.name === "custom"
                    ? onSaveCustomConfiguration()
                    : onSaveProvider(provider.name)
                }
                disabled={
                  saving ||
                  saved ||
                  (provider.name !== "custom" && (missingRequiredApiKey || missingOptionalCredential))
                }
                className={cn(
                  "rounded-full",
                  saved && "opacity-50 cursor-not-allowed",
                )}
                title={timeoutProvider === provider.name ? t("settings.actions.queryTimeout") : undefined}
              >
                {saving
                  ? (learningProvider === provider.name
                      ? t("settings.actions.queryingContext")
                      : t("settings.actions.saving"))
                  : (learningProvider === provider.name
                      ? t("settings.actions.queryingContext")
                      : timeoutProvider === provider.name
                        ? t("settings.actions.queryTimeout")
                        : saved
                          ? tx("settings.providers.saved", "Saved")
                          : tx("settings.providers.saveProvider", "Save provider"))}
              </Button>
              {/* 已配置卡片:显示删除按钮(清除凭证 + 关联 model_preset,移回未配置)。
                  custom 是添加入口,不显示删除(已创建的 preset 在 Models 区域管理) */}
              {provider.configured && provider.name !== "custom" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onRequestDeleteProvider(provider.name)}
                  disabled={saving}
                  className="rounded-full"
                  title={tx("settings.byok.delete", "Delete")}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {tx("settings.byok.delete", "Delete")}
                </Button>
              ) : null}
            </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <div className="space-y-6">
      <p className="max-w-[42rem] text-[13px] leading-6 text-muted-foreground">
        {t("settings.byok.description")}
      </p>
      <ProviderSection
        title={t("settings.byok.configuredSection")}
        count={configuredProviders.length}
        empty={t("settings.byok.noConfiguredProviders")}
      >
        {configuredProviders.map(renderProviderRow)}
      </ProviderSection>
      <ProviderSection
        title={t("settings.byok.notConfiguredSection")}
        count={unconfiguredProviders.length}
        empty={t("settings.byok.noConfiguredProviders")}
      >
        {unconfiguredProviders.map(renderProviderRow)}
      </ProviderSection>
    </div>
  );
}
