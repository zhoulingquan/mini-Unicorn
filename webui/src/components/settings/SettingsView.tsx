// Settings 主入口:调用 useSettingsState hook 获取全部状态与回调,
// 仅保留 JSX 渲染(renderSection + 顶层布局 + 删除 provider 确认 Dialog)。
//
// 行为保持与拆分前完全一致:
//  - 所有 state / useEffect / useCallback / useMemo 已迁出至 ./hooks/useSettingsState
//  - 各 section 通过 props 接收状态与回调
//  - 删除 provider 确认 Dialog 留在此处(与主状态强耦合)
//  - 重新导出 SettingsSectionKey,保证外部 import 路径不变

import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";

import {
  titleForSection,
  type SettingsSectionKey,
  type SettingsViewProps,
} from "./types";
import { SettingsSidebar } from "./components/SettingsSidebar";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import { OverviewSettings } from "./sections/OverviewSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { ModelsSettings } from "./sections/ModelsSettings";
import { ProvidersSettings } from "./sections/ProvidersSettings";
import { AdvancedSettings } from "./sections/AdvancedSettings";
import { NewModelConfigurationDialog } from "./sections/NewModelConfigurationDialog";
import { WebSearchSettings } from "./sections/WebSearchSettings";
import { useSettingsState } from "./hooks/useSettingsState";

// 重新导出共享类型,保证外部 `import { SettingsSectionKey } from "@/components/settings/SettingsView"` 仍可用。
export type { SettingsSectionKey };

export function SettingsView({
  themeMode,
  initialSection = "overview",
  showSidebar = true,
  onSetThemeMode,
  onBackToChat,
  onModelNameChange,
  onSettingsChange,
  onLogout,
  onRestart,
  isRestarting = false,
  hostChromeInset = false,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const { token } = useClient();
  const state = useSettingsState({
    token,
    initialSection,
    onSettingsChange,
    onModelNameChange,
    onRestart,
  });

  const renderSection = () => {
    if (!state.settings) return null;
    switch (state.activeSection) {
      case "overview":
        return (
          <OverviewSettings
            settings={state.settings}
            requiresRestart={state.hasPendingRestart}
            onRestart={state.restartViaSettingsSurface}
            isRestarting={isRestarting || state.hostEngineApplying}
            showBrandLogos={state.localPrefs.brandLogos}
            onSelectSection={state.setActiveSection}
            runtimeForm={state.runtimeForm}
            runtimeDirty={state.runtimeDirty}
            runtimeSaving={state.runtimeSaving}
            onChangeRuntimeForm={state.setRuntimeForm}
            onSaveRuntime={state.saveRuntimeSettings}
          />
        );
      case "appearance":
        return (
          <AppearanceSettings
            themeMode={themeMode}
            onSetThemeMode={onSetThemeMode}
            localPrefs={state.localPrefs}
            onChangeLocalPrefs={state.setLocalPrefs}
          />
        );
      case "models":
        return (
          <div className="space-y-8">
            <ModelsSettings
              form={state.form}
              setForm={state.setForm}
              settings={state.settings}
              dirty={state.modelDirty}
              saving={state.saving}
              contextWindowLearning={state.contextWindowLearning}
              contextWindowLearnTimeout={state.contextWindowLearnTimeout}
              showBrandLogos={state.localPrefs.brandLogos}
              onSave={state.saveModelSettings}
              onSaveContextWindow={state.saveContextWindow}
              onCreateConfiguration={state.openModelConfigurationDialog}
            />
            <ProvidersSettings
              settings={state.settings}
              expandedProvider={state.expandedProvider}
              providerForms={state.providerForms}
              visibleProviderKeys={state.visibleProviderKeys}
              editingProviderKeys={state.editingProviderKeys}
              providerSaving={state.providerSaving}
              providerSaved={state.providerSaved}
              providerModels={state.providerModels}
              providerModelsLoading={state.providerModelsLoading}
              learningProvider={state.learningProvider}
              timeoutProvider={state.timeoutProvider}
              showBrandLogos={state.localPrefs.brandLogos}
              onToggleProvider={state.handleToggleProvider}
              onToggleProviderKey={state.toggleProviderKeyVisibility}
              onToggleProviderKeyEditing={state.toggleProviderKeyEditing}
              onChangeProviderForm={state.changeProviderForm}
              onSaveProvider={state.saveProvider}
              onFetchProviderModels={state.fetchProviderModelList}
              onProviderOAuthLogin={(provider) => state.runProviderOAuth(provider, "login")}
              onProviderOAuthLogout={(provider) => state.runProviderOAuth(provider, "logout")}
              onRequestDeleteProvider={(provider) => state.setProviderToDelete(provider)}
              customPresetLabel={state.customPresetLabel}
              onChangeCustomPresetLabel={state.setCustomPresetLabel}
              onSaveCustomConfiguration={state.saveCustomConfiguration}
            />
          </div>
        );
      case "browser":
        return (
          <WebSearchSettings
            form={state.webSearchForm}
            dirty={state.webSearchDirty}
            saving={state.webSearchSaving}
            onChangeForm={state.setWebSearchForm}
            onSave={state.saveWebSearchSettings}
            onRestart={state.restartViaSettingsSurface}
            isRestarting={isRestarting || state.hostEngineApplying}
            requiresRestartPending={state.pendingRestartSections.browser}
          />
        );
      case "advanced":
        return (
          <AdvancedSettings
            form={state.networkSafetyForm}
            dirty={state.networkSafetyDirty}
            saving={state.networkSafetySaving}
            isNativeHostSurface={(state.settings.surface ?? state.settings.runtime_surface) === "native"}
            onChangeForm={state.setNetworkSafetyForm}
            onSave={state.saveNetworkSafetySettings}
            onRestart={state.restartViaSettingsSurface}
            isRestarting={isRestarting || state.hostEngineApplying}
            requiresRestartPending={state.pendingRestartSections.runtime}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_0%,hsl(var(--muted))_0%,hsl(var(--background))_42%)] md:flex-row">
      {showSidebar ? (
        <SettingsSidebar
          activeSection={state.activeSection}
          onSelectSection={state.setActiveSection}
          onBackToChat={onBackToChat}
          onLogout={onLogout}
          hostChromeInset={hostChromeInset}
        />
      ) : null}

      <NewModelConfigurationDialog
        open={state.modelConfigurationOpen}
        draft={state.modelConfigurationForm}
        providers={state.configuredModelProviderOptions}
        saving={state.modelConfigurationSaving}
        showProviderLogos={state.localPrefs.brandLogos}
        onOpenChange={state.setModelConfigurationOpen}
        onChangeDraft={state.setModelConfigurationForm}
        onSave={state.handleCreateModelConfiguration}
      />

      <Dialog
        open={state.providerToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !state.providerDeleting) state.setProviderToDelete(null);
        }}
      >
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {t("settings.byok.deleteConfirmTitle", { defaultValue: "Delete provider configuration" })}
            </DialogTitle>
            <DialogDescription>
              {t("settings.byok.deleteConfirmDescription", {
                defaultValue:
                  "This will clear the provider's API key, API base, and associated model configurations. This action cannot be undone.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => state.setProviderToDelete(null)}
              disabled={state.providerDeleting}
              className="rounded-full"
            >
              {t("settings.bootstrap.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              variant="destructive"
              onClick={state.confirmDeleteProvider}
              disabled={state.providerDeleting}
              className="rounded-full"
            >
              {state.providerDeleting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              {state.providerDeleting
                ? t("settings.byok.deleting", { defaultValue: "Deleting..." })
                : t("settings.byok.deleteConfirmAction", { defaultValue: "Delete" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          className={cn(
            "mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 lg:py-12",
            hostChromeInset && "pt-[4.25rem] sm:pt-[4.25rem] lg:pt-[4.75rem]",
          )}
        >
          <div className="mb-7">
            <p className="mb-2 text-[13px] font-medium text-muted-foreground">
              {t("settings.sidebar.title")}
            </p>
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[34px]">
              {state.text(`settings.nav.${state.activeSection}`, titleForSection(state.activeSection))}
            </h1>
          </div>

          {state.loading ? (
            <div className="flex h-48 items-center justify-center rounded-[24px] border border-border/50 bg-card/75 text-sm text-muted-foreground shadow-[0_20px_70px_rgba(15,23,42,0.07)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.status.loading")}
            </div>
          ) : state.error && !state.settings ? (
            <SettingsGroup>
              <SettingsRow title={t("settings.status.loadError")}>
                <span className="max-w-[520px] text-sm text-muted-foreground">{state.error}</span>
              </SettingsRow>
            </SettingsGroup>
          ) : state.settings ? (
            <div className="space-y-5">
              {state.error ? (
                <div className="rounded-[18px] border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                  {state.error}
                </div>
              ) : null}
              {renderSection()}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
