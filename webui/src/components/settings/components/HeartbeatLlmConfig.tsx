// Heartbeat 专用 LLM 配置行:Overview section 内嵌使用。
// 从 SettingsView.tsx 拆分而来。

import type { Dispatch, SetStateAction } from "react";
import { Check, ChevronDown, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { RuntimeSettingsUpdate, SettingsPayload } from "@/lib/types";

import { SettingsRow } from "./SettingsRow";

/**
 * Heartbeat 专用 LLM 配置。一个 SettingsRow,右侧下拉列表展示所有已配置的
 * model_presets,让用户为 heartbeat 选择一个专用 LLM;选"使用主模型"
 * 则 heartbeat 复用 agent 主 provider/model。
 */
export function HeartbeatLlmConfig({
  runtimeForm,
  onChangeRuntimeForm,
  settings,
}: {
  runtimeForm: RuntimeSettingsUpdate;
  onChangeRuntimeForm: Dispatch<SetStateAction<RuntimeSettingsUpdate>>;
  settings: SettingsPayload;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const presets = settings.model_presets;
  const currentValue = runtimeForm.heartbeatModelPreset ?? settings.runtime.heartbeat.model_preset ?? "";
  const selectedPreset = presets.find((p) => p.name === currentValue) ?? null;
  const defaultOptionLabel = tx("settings.heartbeat.useMain", "Main model");

  return (
    <SettingsRow
      icon={KeyRound}
      title={tx("settings.heartbeat.llmTitle", "Heartbeat LLM")}
      description={
        selectedPreset
          ? t("settings.heartbeat.configuredHint", {
              defaultValue: "Using: {{model}}",
              model: selectedPreset.model,
            })
          : tx("settings.heartbeat.defaultHint", "Using main agent model.")
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-8 w-[min(220px,50vw)] justify-between rounded-full border-input bg-background px-3 text-[12.5px] font-normal shadow-none hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate text-left">
              {selectedPreset ? selectedPreset.label || selectedPreset.model : defaultOptionLabel}
            </span>
            <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-[20rem] w-[260px] max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          <DropdownMenuItem
            onSelect={() =>
              onChangeRuntimeForm((prev) => ({ ...prev, heartbeatModelPreset: "" }))
            }
            className={cn(
              "flex cursor-default items-center justify-between gap-2 rounded-[12px] px-2.5 py-2 text-[13px]",
              "focus:bg-muted/85 focus:text-foreground",
              !currentValue && "bg-muted/80 text-foreground focus:bg-muted",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{defaultOptionLabel}</span>
              <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                {settings.agent.model || "—"}
              </span>
            </span>
            {!currentValue ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
          </DropdownMenuItem>
          {presets.length > 0 ? <div className="my-1 border-t border-border/55" /> : null}
          {presets.map((preset) => {
            const selected = preset.name === currentValue;
            return (
              <DropdownMenuItem
                key={preset.name}
                onSelect={() =>
                  onChangeRuntimeForm((prev) => ({ ...prev, heartbeatModelPreset: preset.name }))
                }
                className={cn(
                  "flex cursor-default items-center justify-between gap-2 rounded-[12px] px-2.5 py-2 text-[13px]",
                  "focus:bg-muted/85 focus:text-foreground",
                  selected && "bg-muted/80 text-foreground focus:bg-muted",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{preset.label || preset.name}</span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                    {preset.model}
                  </span>
                </span>
                {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}
