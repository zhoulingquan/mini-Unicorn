// Provider 卡片展开区下挂的 preset 子列表:
// 展示该 provider 下挂载的命名 preset(不含 default),每项显示 label+model,
// 当前激活的 preset 带标记,并提供删除与激活入口。

import { Trash2, Plus, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

interface ProviderPreset {
  name: string;
  label: string;
  model: string;
  active: boolean;
}

interface ProviderPresetListProps {
  presets: ProviderPreset[];
  saving: boolean;
  onDelete: (presetName: string) => void;
  onActivate: (presetName: string) => void;
  onAdd: () => void;
}

export function ProviderPresetList({
  presets,
  saving,
  onDelete,
  onActivate,
  onAdd,
}: ProviderPresetListProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  if (presets.length === 0) {
    return (
      <div className="mt-3 flex items-center justify-between rounded-lg border border-dashed border-border/60 px-3 py-2">
        <span className="text-[12px] text-muted-foreground">
          {tx("settings.byok.noPresets", "Continue to add other models")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2 text-[12px]"
          disabled={saving}
          onClick={onAdd}
        >
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          {tx("settings.byok.addModelToProvider", "Add model")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border/45 bg-muted/20">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <span className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
          {tx("settings.byok.modelsUnderProvider", "Models under this provider")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2 text-[12px]"
          disabled={saving}
          onClick={onAdd}
        >
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          {tx("settings.byok.addModelToProvider", "Add model")}
        </Button>
      </div>
      <ul className="divide-y divide-border/30">
        {presets.map((preset) => (
          <li
            key={preset.name}
            className="flex items-center justify-between gap-2 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{preset.label}</span>
                {preset.active ? (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                    <Check className="h-2.5 w-2.5" aria-hidden />
                    {tx("settings.byok.activePreset", "Active")}
                  </span>
                ) : null}
              </div>
              {/* label 与 model 相同时只显示一行,避免重复 */}
              {preset.label !== preset.model ? (
                <div className="truncate text-[11.5px] text-muted-foreground">{preset.model}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {!preset.active ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-full px-2 text-[11.5px]"
                  disabled={saving}
                  onClick={() => onActivate(preset.name)}
                >
                  {tx("settings.byok.activate", "Activate")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 rounded-full p-0 text-muted-foreground hover:text-destructive"
                disabled={saving}
                onClick={() => onDelete(preset.name)}
                aria-label={tx("settings.byok.delete", "Delete")}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
