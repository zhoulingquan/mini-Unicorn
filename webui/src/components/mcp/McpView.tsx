import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleDot,
  ExternalLink,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchMcpPresets,
  runMcpPresetAction,
} from "@/lib/api";
import {
  installedMcpPresetsFromPayload,
  isMcpPresetsPayload,
  MCP_PRESETS_CHANGED_EVENT,
} from "@/lib/mcp-preset-events";
import type { McpPresetInfo, McpPresetsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

type McpStatus = McpPresetInfo["status"];

function statusIcon(status: McpStatus) {
  switch (status) {
    case "configured":
      return <Check className="h-3.5 w-3.5 text-emerald-500" />;
    case "missing_credentials":
    case "missing_dependency":
      return <X className="h-3.5 w-3.5 text-amber-500" />;
    case "not_installed":
      return <CircleDot className="h-3.5 w-3.5 text-muted-foreground/50" />;
    default:
      return <CircleDot className="h-3.5 w-3.5 text-muted-foreground/50" />;
  }
}

interface McpViewProps {
  onBack: () => void;
  onOpenSettings: () => void;
  token: string;
}

export function McpView({ onBack, onOpenSettings, token }: McpViewProps) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<McpPresetsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [acting, setActing] = useState<string | null>(null);

  const loadPresets = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMcpPresets(token);
      setPayload(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPresets();
  }, [token]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (isMcpPresetsPayload(detail)) setPayload(detail);
    };
    window.addEventListener(MCP_PRESETS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(MCP_PRESETS_CHANGED_EVENT, handler);
  }, []);

  const handleAction = async (preset: McpPresetInfo, action: "enable" | "remove") => {
    setActing(preset.name);
    try {
      const updated = await runMcpPresetAction(token, action, preset.name, {});
      setPayload(updated);
    } catch {
      // ignore
    } finally {
      setActing(null);
    }
  };

  const presets = payload?.presets ?? [];
  const installed = installedMcpPresetsFromPayload(payload ?? { presets: [], installed_count: 0 });
  const filtered = search
    ? presets.filter(
        (p) =>
          p.display_name.toLowerCase().includes(search.toLowerCase()) ||
          p.description.toLowerCase().includes(search.toLowerCase()),
      )
    : presets;

  const connected = filtered.filter((p) => p.status === "configured");
  const available = filtered.filter((p) => p.status !== "configured");

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <PlugZap className="h-4.5 w-4.5 text-foreground/80" />
          <h1 className="text-sm font-semibold">{t("mcp.title")}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={loadPresets}
            disabled={loading}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="border-b px-4 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            placeholder={t("mcp.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && !payload ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("mcp.loading")}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={loadPresets}>
              {t("mcp.retry")}
            </Button>
          </div>
        ) : (
          <>
            {connected.length > 0 && (
              <section className="mb-4">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("mcp.connected")} ({connected.length})
                </h2>
                <div className="space-y-1.5">
                  {connected.map((preset) => (
                    <McpCard
                      key={preset.name}
                      preset={preset}
                      acting={acting}
                      onAction={handleAction}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            )}
            {available.length > 0 && (
              <section>
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("mcp.available")} ({available.length})
                </h2>
                <div className="space-y-1.5">
                  {available.map((preset) => (
                    <McpCard
                      key={preset.name}
                      preset={preset}
                      acting={acting}
                      onAction={handleAction}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            )}
            {filtered.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("mcp.empty")}
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t px-4 py-2.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
          <span>
            {installed.length} {t("mcp.connected").toLowerCase()}
          </span>
          <Button
            variant="link"
            className="h-auto p-0 text-[11px] text-muted-foreground/70"
            onClick={onOpenSettings}
          >
            {t("mcp.advancedSettings")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function McpCard({
  preset,
  acting,
  onAction,
  t,
}: {
  preset: McpPresetInfo;
  acting: string | null;
  onAction: (preset: McpPresetInfo, action: "enable" | "remove") => void;
  t: (key: string) => string;
}) {
  const isActing = acting === preset.name;
  const isConnected = preset.status === "configured";

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
        isConnected
          ? "border-emerald-500/20 bg-emerald-500/[0.04]"
          : "border-border/50 bg-background",
      )}
    >
      <div
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white text-[11px] font-bold"
        style={{ backgroundColor: preset.brand_color || "#6b7280" }}
      >
        {preset.display_name.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-medium leading-tight">
            {preset.display_name}
          </span>
          {statusIcon(preset.status)}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/70 line-clamp-2">
          {preset.description}
        </p>
        {preset.tool_count != null && preset.tool_count > 0 && (
          <p className="mt-0.5 text-[10px] text-muted-foreground/50">
            {preset.tool_count} {t("mcp.tools")}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-0.5">
        {preset.docs_url && (
          <a
            href={preset.docs_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {isConnected ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-amber-600 hover:text-amber-700"
            disabled={isActing}
            onClick={() => onAction(preset, "remove")}
          >
            {isActing ? <Loader2 className="h-3 w-3 animate-spin" /> : t("mcp.disconnect")}
          </Button>
        ) : preset.install_supported ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-emerald-600 hover:text-emerald-700"
            disabled={isActing}
            onClick={() => onAction(preset, "enable")}
          >
            {isActing ? <Loader2 className="h-3 w-3 animate-spin" /> : t("mcp.connect")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
