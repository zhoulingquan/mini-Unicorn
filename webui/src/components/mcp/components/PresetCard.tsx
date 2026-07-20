import { Check, CircleDot, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { McpPresetField, McpPresetInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

function statusIcon(status: McpPresetInfo["status"]) {
  switch (status) {
    case "configured":
      return <Check className="h-3.5 w-3.5 text-emerald-500" />;
    case "missing_credentials":
    case "missing_dependency":
      return <X className="h-3.5 w-3.5 text-amber-500" />;
    default:
      return <CircleDot className="h-3.5 w-3.5 text-muted-foreground/50" />;
  }
}

export function PresetCard({
  server,
  expanded,
  formValues,
  enabling,
  error,
  onEnable,
  onRemove,
  onFieldChange,
  onCancel,
}: {
  server: McpPresetInfo;
  expanded: boolean;
  formValues: Record<string, string>;
  enabling: boolean;
  error: string | null;
  onEnable: () => void;
  onRemove: () => void;
  onFieldChange: (field: string, value: string) => void;
  onCancel: () => void;
}) {
  // 子组件直接调用 useTranslation,保留 i18next 的类型推断
  const { t } = useTranslation();
  const isConfigured = server.status === "configured";
  const hasError =
    server.status === "missing_credentials" || server.status === "missing_dependency";
  const fields = server.required_fields ?? [];
  const needsFields = fields.length > 0;

  return (
    <div
      className={cn(
        "group flex flex-col transition-colors",
        "rounded-lg border px-2.5 py-2",
        hasError
          ? "border-amber-500/40 bg-amber-500/[0.03]"
          : isConfigured
            ? "border-border bg-background hover:border-violet-500/60"
            : "border-border bg-muted/20 opacity-70 hover:opacity-100",
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white"
          style={{ backgroundColor: server.brand_color || "#6b7280" }}
        >
          {server.display_name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-medium leading-tight">
              {server.display_name}
            </span>
            {statusIcon(server.status)}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/60">
            <span className="uppercase">{server.transport}</span>
          </div>
        </div>
        <ToggleSwitch
          checked={isConfigured}
          disabled={enabling}
          onClick={isConfigured ? onRemove : onEnable}
          ariaLabel={isConfigured ? t("mcp.enabled") : t("mcp.enable")}
        />
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
        {server.description}
      </p>

      {expanded && needsFields && (
        <div className="mt-2 space-y-2 rounded-md border border-border/40 bg-muted/20 p-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t("mcp.presetFields")}
          </p>
          {fields.map((field: McpPresetField) => (
            <div key={field.name} className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground/80">
                {field.label}
                {field.required && <span className="ml-0.5 text-destructive">*</span>}
              </label>
              <Input
                type={field.secret ? "password" : "text"}
                placeholder={field.placeholder ?? ""}
                value={formValues[field.name] ?? ""}
                onChange={(e) => onFieldChange(field.name, e.target.value)}
                className="h-6 text-[11px]"
              />
            </div>
          ))}
          {server.note && (
            <p className="text-[10px] text-muted-foreground/60">
              <span className="font-medium">{t("mcp.note")}: </span>
              {server.note}
            </p>
          )}
          {error && (
            <p className="text-[11px] text-destructive">{error}</p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2.5 text-[11px]"
              onClick={onCancel}
            >
              {t("mcp.form.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-6 gap-1 px-2.5 text-[11px]"
              disabled={enabling}
              onClick={onEnable}
            >
              {enabling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {t("mcp.form.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
