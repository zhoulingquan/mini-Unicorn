// Advanced section:Web/App 安全设置(本地服务访问 + 默认访问模式)。
// 从 SettingsView.tsx 拆分而来。

import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import type {
  NetworkSafetySettingsUpdate,
  WebuiDefaultAccessMode,
} from "@/lib/types";

import { SegmentedControl, ToggleButton } from "../components/SegmentedControl";
import { RestartSettingsFooter } from "../components/RestartSettingsFooter";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
} from "../components/SettingsRow";

export function AdvancedSettings({
  form,
  dirty,
  saving,
  requiresRestartPending,
  isNativeHostSurface,
  onChangeForm,
  onSave,
  onRestart,
  isRestarting,
}: {
  form: NetworkSafetySettingsUpdate;
  dirty: boolean;
  saving: boolean;
  requiresRestartPending: boolean;
  isNativeHostSurface: boolean;
  onChangeForm: Dispatch<SetStateAction<NetworkSafetySettingsUpdate>>;
  onSave: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>
          {isNativeHostSurface
            ? tx("settings.sections.hostSafety", "App safety")
            : tx("settings.sections.webuiSafety", "Web safety")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.localServiceAccess", "Local Service Access")}
            description={tx(
              isNativeHostSurface ? "settings.help.localServiceAccessNative" : "settings.help.localServiceAccess",
              isNativeHostSurface
                ? "Allow Full Access shell commands to reach services on this Mac."
                : "Allow Full Access shell commands to reach localhost services.",
            )}
          >
            <ToggleButton
              checked={form.webuiAllowLocalServiceAccess}
              onChange={(webuiAllowLocalServiceAccess) =>
                onChangeForm((prev) => ({ ...prev, webuiAllowLocalServiceAccess }))
              }
              ariaLabel={tx("settings.rows.localServiceAccess", "Local Service Access")}
              label={form.webuiAllowLocalServiceAccess ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.webuiDefaultAccess", "Default access")}
            description={tx(
              isNativeHostSurface ? "settings.help.webuiDefaultAccessNative" : "settings.help.webuiDefaultAccess",
              isNativeHostSurface
                ? "Used by native chats without a project-specific permission."
                : "Used by web chats without a project-specific permission.",
            )}
          >
            <SegmentedControl
              value={form.webuiDefaultAccessMode}
              options={[
                { value: "default", label: tx("settings.values.defaultPermission", "Default Permission") },
                { value: "full", label: tx("settings.values.fullAccess", "Full Access") },
              ]}
              onChange={(webuiDefaultAccessMode) =>
                onChangeForm((prev) => ({
                  ...prev,
                  webuiDefaultAccessMode: webuiDefaultAccessMode as WebuiDefaultAccessMode,
                }))
              }
            />
          </SettingsRow>
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            onSave={onSave}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>

      <p className="max-w-3xl px-1 text-sm leading-6 text-muted-foreground">
        {tx(
          "settings.help.securityManagedControls",
          "Web fetches always protect local, private, and metadata services. Core channel safety stays in config.json.",
        )}
      </p>
    </div>
  );
}
