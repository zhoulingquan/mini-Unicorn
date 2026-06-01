import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  Loader2,
  Plus,
  PlugZap,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fetchMcpPresets,
  runMcpPresetAction,
  saveCustomMcpServer,
} from "@/lib/api";
import {
  isMcpPresetsPayload,
  MCP_PRESETS_CHANGED_EVENT,
} from "@/lib/mcp-preset-events";
import type { McpPresetInfo, McpPresetsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

type TransportType = "stdio" | "sse" | "streamableHttp";

interface McpViewProps {
  onBack: () => void;
  onOpenSettings: () => void;
  token: string;
}

interface CustomServerForm {
  name: string;
  transport: TransportType;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  tool_timeout: string;
  enabled_tools: string;
}

const EMPTY_FORM: CustomServerForm = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  cwd: "",
  url: "",
  headers: "",
  tool_timeout: "30",
  enabled_tools: "*",
};

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

export function McpView({ onBack, onOpenSettings, token }: McpViewProps) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<McpPresetsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CustomServerForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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

  const handleRemove = async (name: string) => {
    setActing(name);
    try {
      const updated = await runMcpPresetAction(token, "remove", name, {});
      setPayload(updated);
    } catch {
      // ignore
    } finally {
      setActing(null);
    }
  };

  const handleSaveCustom = async () => {
    if (!form.name.trim()) {
      setFormError(t("mcp.validation.nameRequired"));
      return;
    }
    if (form.transport === "stdio" && !form.command.trim()) {
      setFormError(t("mcp.validation.commandRequired"));
      return;
    }
    if ((form.transport === "sse" || form.transport === "streamableHttp") && !form.url.trim()) {
      setFormError(t("mcp.validation.urlRequired"));
      return;
    }

    if (form.args.trim()) {
      try {
        JSON.parse(form.args);
      } catch {
        setFormError(t("mcp.validation.invalidJsonArgs"));
        return;
      }
    }
    if (form.env.trim()) {
      try {
        JSON.parse(form.env);
      } catch {
        setFormError(t("mcp.validation.invalidJsonEnv"));
        return;
      }
    }
    if (form.headers.trim()) {
      try {
        JSON.parse(form.headers);
      } catch {
        setFormError(t("mcp.validation.invalidJsonHeaders"));
        return;
      }
    }

    setSaving(true);
    setFormError(null);
    try {
      const values: Record<string, string> = {
        name: form.name.trim(),
        transport: form.transport,
        tool_timeout: form.tool_timeout || "30",
      };
      if (form.transport === "stdio") {
        values.command = form.command.trim();
        if (form.args.trim()) values.args = form.args.trim();
        if (form.env.trim()) values.env = form.env.trim();
        if (form.cwd.trim()) values.cwd = form.cwd.trim();
      } else {
        values.url = form.url.trim();
        if (form.headers.trim()) values.headers = form.headers.trim();
      }
      if (form.enabled_tools.trim()) {
        values.enabled_tools = form.enabled_tools.trim();
      }

      const updated = await saveCustomMcpServer(token, values);
      setPayload(updated);
      setShowForm(false);
      setForm(EMPTY_FORM);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const allServers = payload?.presets ?? [];
  const servers = allServers.filter((s) => s.source !== "preset");
  const installed = servers.filter((s) => s.status === "configured");

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
            {servers.length > 0 && (
              <section className="mb-4">
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("mcp.connected")} ({installed.length})
                </h2>
                <div className="space-y-1.5">
                  {servers.map((server) => (
                    <ServerCard
                      key={server.name}
                      server={server}
                      acting={acting}
                      onRemove={handleRemove}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            )}

            {servers.length === 0 && !showForm && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("mcp.empty")}
              </div>
            )}

            {showForm ? (
              <section>
                <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t("mcp.addServer")}
                </h2>
                <div className="space-y-3 rounded-xl border border-border/50 bg-background p-3">
                  <FormField label={t("mcp.form.name")} required>
                    <Input
                      placeholder={t("mcp.form.namePlaceholder")}
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      className="h-8 text-[12.5px]"
                    />
                  </FormField>

                  <FormField label={t("mcp.form.transport")} required>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          className="h-8 w-full justify-between text-[12.5px] font-normal"
                        >
                          {form.transport}
                          <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="min-w-[160px]">
                        {(["stdio", "sse", "streamableHttp"] as TransportType[]).map((t) => (
                          <DropdownMenuItem
                            key={t}
                            onClick={() => setForm((f) => ({ ...f, transport: t }))}
                            className="text-[12.5px]"
                          >
                            {t}
                            {form.transport === t && <Check className="ml-auto h-3 w-3" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </FormField>

                  {form.transport === "stdio" ? (
                    <>
                      <FormField label={t("mcp.form.command")} required>
                        <Input
                          placeholder="npx"
                          value={form.command}
                          onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                          className="h-8 text-[12.5px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.args")}>
                        <Textarea
                          placeholder='["-y", "@playwright/mcp@latest"]'
                          value={form.args}
                          onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                          className="min-h-[56px] text-[12px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.env")}>
                        <Textarea
                          placeholder='{"API_KEY": "sk-..."}'
                          value={form.env}
                          onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                          className="min-h-[56px] text-[12px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.cwd")}>
                        <Input
                          placeholder="/path/to/working/dir"
                          value={form.cwd}
                          onChange={(e) => setForm((f) => ({ ...f, cwd: e.target.value }))}
                          className="h-8 text-[12.5px] font-mono"
                        />
                      </FormField>
                    </>
                  ) : (
                    <>
                      <FormField label={t("mcp.form.url")} required>
                        <Input
                          placeholder="https://example.com/mcp"
                          value={form.url}
                          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                          className="h-8 text-[12.5px] font-mono"
                        />
                      </FormField>
                      <FormField label={t("mcp.form.headers")}>
                        <Textarea
                          placeholder='{"Authorization": "Bearer ..."}'
                          value={form.headers}
                          onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
                          className="min-h-[56px] text-[12px] font-mono"
                        />
                      </FormField>
                    </>
                  )}

                  <FormField label={t("mcp.form.toolTimeout")}>
                    <Input
                      type="number"
                      min={5}
                      max={600}
                      value={form.tool_timeout}
                      onChange={(e) => setForm((f) => ({ ...f, tool_timeout: e.target.value }))}
                      className="h-8 w-24 text-[12.5px]"
                    />
                  </FormField>

                  <FormField label={t("mcp.form.enabledTools")}>
                    <Input
                      placeholder="*"
                      value={form.enabled_tools}
                      onChange={(e) => setForm((f) => ({ ...f, enabled_tools: e.target.value }))}
                      className="h-8 text-[12.5px] font-mono"
                    />
                  </FormField>

                  {formError && (
                    <p className="text-[11px] text-destructive">{formError}</p>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      className="h-7 text-[11px]"
                      disabled={saving}
                      onClick={handleSaveCustom}
                    >
                      {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                      {t("mcp.form.save")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => {
                        setShowForm(false);
                        setForm(EMPTY_FORM);
                        setFormError(null);
                      }}
                    >
                      {t("mcp.form.cancel")}
                    </Button>
                  </div>
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      <div className="border-t px-4 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground/70">
            {installed.length} {t("mcp.connected").toLowerCase()}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="link"
              className="h-auto p-0 text-[11px] text-muted-foreground/70"
              onClick={onOpenSettings}
            >
              {t("mcp.advancedSettings")}
            </Button>
            {!showForm && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px] text-emerald-600 hover:text-emerald-700"
                onClick={() => setShowForm(true)}
              >
                <Plus className="h-3 w-3" />
                {t("mcp.addServer")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerCard({
  server,
  acting,
  onRemove,
  t,
}: {
  server: McpPresetInfo;
  acting: string | null;
  onRemove: (name: string) => void;
  t: (key: string) => string;
}) {
  const isActing = acting === server.name;
  const isConfigured = server.status === "configured";

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
        isConfigured
          ? "border-emerald-500/20 bg-emerald-500/[0.04]"
          : "border-border/50 bg-background",
      )}
    >
      <div
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white text-[11px] font-bold"
        style={{ backgroundColor: server.brand_color || "#6b7280" }}
      >
        {server.display_name.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-medium leading-tight">
            {server.display_name}
          </span>
          {statusIcon(server.status)}
          <span className="text-[10px] text-muted-foreground/50 uppercase">
            {server.transport}
          </span>
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/70 line-clamp-2">
          {server.connection_summary || server.description}
        </p>
        {server.tool_count != null && server.tool_count > 0 && (
          <p className="mt-0.5 text-[10px] text-muted-foreground/50">
            {server.tool_count} {t("mcp.tools")}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-0.5">
        {server.docs_url && (
          <a
            href={server.docs_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-accent/40 hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-amber-600 hover:text-amber-700"
          disabled={isActing}
          onClick={() => onRemove(server.name)}
        >
          {isActing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        </Button>
      </div>
    </div>
  );
}

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground/80">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
