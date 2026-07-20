import {
  Check,
  CircleDot,
  ExternalLink,
  Loader2,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import type { McpPresetInfo } from "@/lib/types";
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

export function ServerCard({
  server,
  acting,
  testing,
  testResult,
  showTools,
  enabledToolsCache,
  savingTools,
  toolsError,
  onRemove,
  onTest,
  onToggleTools,
  onToggleTool,
  onSelectAll,
  onClear,
  onSaveTools,
}: {
  server: McpPresetInfo;
  acting: string | null;
  testing: boolean;
  testResult?: { ok: boolean; message: string; toolCount?: number };
  showTools: boolean;
  enabledToolsCache: string[] | null;
  savingTools: boolean;
  toolsError: string | null;
  onRemove: (name: string) => void;
  onTest: () => void;
  onToggleTools: () => void;
  onToggleTool: (tool: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSaveTools: () => void;
}) {
  // 子组件直接调用 useTranslation,保留 i18next 的类型推断
  const { t } = useTranslation();
  const isActing = acting === server.name;
  const isConfigured = server.status === "configured";
  const toolNames = server.tool_names ?? [];
  const hasTools = toolNames.length > 0;
  const selected = enabledToolsCache ?? [];
  const docsUrl = server.docs_url;

  return (
    <div
      className={cn(
        "group flex flex-col transition-colors",
        "rounded-lg border px-2.5 py-2",
        isConfigured
          ? "border-border bg-background hover:border-violet-500/60"
          : "border-amber-500/40 bg-amber-500/[0.03]",
      )}
    >
      {/* Header: icon + name + status + toggle */}
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
            {server.tool_count != null && server.tool_count > 0 && (
              <>
                <span>·</span>
                <span>{server.tool_count} {t("mcp.tools")}</span>
              </>
            )}
          </div>
        </div>
        <ToggleSwitch
          checked={isConfigured}
          disabled={isActing}
          onClick={() => onRemove(server.name)}
          ariaLabel={t("mcp.enabled")}
        />
      </div>

      {/* Body: description */}
      <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
        {server.connection_summary || server.description}
      </p>

      {/* Test result */}
      {testResult && (
        <div
          className={cn(
            "mt-1.5 rounded px-1.5 py-1 text-[10px]",
            testResult.ok
              ? "bg-violet-500/10 text-violet-600"
              : "bg-destructive/10 text-destructive",
          )}
        >
          {testResult.message}
        </div>
      )}

      {/* Tools panel */}
      {showTools && (
        <div className="mt-2 rounded-md border border-border/40 bg-muted/20 p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t("mcp.toolList")}
            </span>
            {hasTools && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground/70"
                  onClick={onSelectAll}
                >
                  {t("mcp.selectAll")}
                </Button>
                <span className="text-muted-foreground/30">·</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground/70"
                  onClick={onClear}
                >
                  {t("mcp.clearAll")}
                </Button>
              </div>
            )}
          </div>
          {!hasTools ? (
            <p className="py-1.5 text-center text-[10px] text-muted-foreground/60">
              {t("mcp.noTools")}
            </p>
          ) : (
            <>
              <div className="max-h-32 space-y-0.5 overflow-y-auto pr-1">
                {toolNames.map((tool) => (
                  <div
                    key={tool}
                    className="flex cursor-pointer items-center justify-between gap-1.5 rounded px-1 py-0.5 hover:bg-accent/30"
                  >
                    <span className="truncate text-[10px]">{tool}</span>
                    <ToggleSwitch
                      checked={selected.includes(tool)}
                      onClick={() => onToggleTool(tool)}
                      ariaLabel={tool}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-end border-t border-border/40 pt-1.5">
                <Button
                  size="sm"
                  className="h-6 gap-1 px-2.5 text-[11px]"
                  disabled={savingTools}
                  onClick={onSaveTools}
                >
                  {savingTools ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {t("mcp.saveTools")}
                </Button>
              </div>
              {toolsError && (
                <p className="mt-1.5 text-[11px] text-destructive">{toolsError}</p>
              )}
            </>
          )}
        </div>
      )}

      {/* Footer: actions */}
      <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-1.5">
        <div className="flex items-center gap-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-violet-600 hover:bg-violet-500/10"
            disabled={testing}
            onClick={onTest}
            title={t("mcp.test")}
          >
            {testing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Zap className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-sky-600 hover:bg-sky-500/10"
            onClick={onToggleTools}
            title={t("mcp.toolsManage")}
          >
            <Wrench className="h-3 w-3" />
          </Button>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                window.open(docsUrl, "_blank", "noopener,noreferrer");
              }}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground"
              title={docsUrl}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-red-600 hover:bg-red-500/10"
          disabled={isActing}
          onClick={() => onRemove(server.name)}
          title={t("mcp.delete")}
        >
          {isActing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}
