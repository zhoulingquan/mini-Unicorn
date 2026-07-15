import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  LayoutGrid,
  List,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteTool, fetchTools, importToolFile } from "@/lib/api";
import type { ToolPayload, ToolsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ToolsViewProps {
  onBack: () => void;
  token: string;
}

export function ToolsView({ onBack, token }: ToolsViewProps) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<ToolsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importName, setImportName] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [actingName, setActingName] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTools(token);
      setPayload(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Initial load
  useEffect(() => {
    void load();
  }, [load]);

  const handleFileSelect = async (file: File) => {
    setImportError(null);
    setImportSuccess(null);
    if (!file.name.endsWith(".py")) {
      setImportError(t("tools.error.notPy"));
      return;
    }
    try {
      const text = await file.text();
      setImportContent(text);
      setImportName(file.name);
    } catch {
      setImportError(t("tools.error.readFailed"));
    }
  };

  const handleImport = async () => {
    if (importing) return;
    const name = importName.trim();
    if (!name) {
      setImportError(t("tools.error.nameRequired"));
      return;
    }
    if (!name.endsWith(".py")) {
      setImportError(t("tools.error.notPy"));
      return;
    }
    if (!importContent.trim()) {
      setImportError(t("tools.error.emptyContent"));
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const result = await importToolFile(token, name, importContent);
      setImportSuccess(result.message || t("tools.importSuccess"));
      setImportName("");
      setImportContent("");
      setShowImport(false);
      await load();
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (tool: ToolPayload) => {
    if (actingName) return;
    if (tool.source !== "user") return;
    setActingName(tool.name);
    try {
      await deleteTool(token, tool.name);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActingName(null);
    }
  };

  const tools = payload?.tools ?? [];
  const builtinTools = tools.filter((t) => t.source === "builtin");
  const mcpTools = tools.filter((t) => t.source === "mcp");
  const userTools = tools.filter((t) => t.source === "user");

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <Package className="h-4.5 w-4.5 text-foreground/80" />
          <h1 className="text-sm font-semibold">{t("tools.title")}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-md border bg-muted/40 p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-6 w-6 rounded-sm",
                viewMode === "list"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setViewMode("list")}
              title={t("tools.listView")}
              aria-label={t("tools.listView")}
              aria-pressed={viewMode === "list"}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-6 w-6 rounded-sm",
                viewMode === "grid"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setViewMode("grid")}
              title={t("tools.gridView")}
              aria-label={t("tools.gridView")}
              aria-pressed={viewMode === "grid"}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => {
              setShowImport((v) => !v);
              setImportName("");
              setImportContent("");
              setImportError(null);
              setImportSuccess(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("tools.import")}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              {t("tools.retry")}
            </Button>
          </div>
        ) : loading && !payload ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("tools.loading")}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {showImport ? (
              <ImportForm
                name={importName}
                content={importContent}
                onNameChange={setImportName}
                onContentChange={setImportContent}
                onFileSelect={handleFileSelect}
                onSave={handleImport}
                onCancel={() => {
                  setShowImport(false);
                  setImportName("");
                  setImportContent("");
                  setImportError(null);
                  setImportSuccess(null);
                }}
                saving={importing}
                error={importError}
                success={importSuccess}
                t={t}
              />
            ) : null}

            {userTools.length > 0 ? (
              <ToolSection
                title={t("tools.userTools")}
                tools={userTools}
                actingName={actingName}
                onDelete={handleDelete}
                viewMode={viewMode}
                t={t}
              />
            ) : null}

            {builtinTools.length > 0 ? (
              <ToolSection
                title={t("tools.builtinTools")}
                tools={builtinTools}
                actingName={actingName}
                onDelete={handleDelete}
                viewMode={viewMode}
                t={t}
              />
            ) : null}

            {mcpTools.length > 0 ? (
              <ToolSection
                title={t("tools.mcpTools")}
                tools={mcpTools}
                actingName={actingName}
                onDelete={handleDelete}
                viewMode={viewMode}
                t={t}
              />
            ) : null}

            {tools.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Package className="h-8 w-8 opacity-40" />
                <p>{t("tools.empty")}</p>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

interface ToolSectionProps {
  title: string;
  tools: ToolPayload[];
  actingName: string | null;
  onDelete: (tool: ToolPayload) => void;
  viewMode: "list" | "grid";
  t: (key: string, options?: Record<string, unknown>) => string;
}

function ToolSection({ title, tools, actingName, onDelete, viewMode, t }: ToolSectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} ({tools.length})
      </h2>
      <div
        className={cn(
          viewMode === "grid"
            ? "grid grid-cols-2 gap-2"
            : "flex flex-col gap-2",
        )}
      >
        {tools.map((tool) => (
          <ToolCard
            key={`${tool.source}-${tool.name}`}
            tool={tool}
            acting={actingName === tool.name}
            onDelete={() => onDelete(tool)}
            viewMode={viewMode}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}

interface ToolCardProps {
  tool: ToolPayload;
  acting: boolean;
  onDelete: () => void;
  viewMode: "list" | "grid";
  t: (key: string, options?: Record<string, unknown>) => string;
}

function ToolCard({ tool, acting, onDelete, viewMode, t }: ToolCardProps) {
  const sourceLabel =
    tool.source === "builtin"
      ? t("tools.badge.builtin")
      : tool.source === "mcp"
        ? t("tools.badge.mcp")
        : t("tools.badge.user");

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 transition-colors",
        !tool.loaded && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-sm font-medium">
              {tool.name}
            </span>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                tool.source === "user"
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : tool.source === "mcp"
                    ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {sourceLabel}
            </span>
            {!tool.loaded ? (
              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                {t("tools.badge.notLoaded")}
              </span>
            ) : null}
            {tool.read_only ? (
              <span className="shrink-0 rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                {t("tools.badge.readOnly")}
              </span>
            ) : null}
          </div>
          {tool.description ? (
            <p
              className={cn(
                "text-xs text-muted-foreground",
                viewMode === "grid" ? "line-clamp-1" : "line-clamp-2",
              )}
            >
              {tool.description}
            </p>
          ) : (
            <p className="text-xs italic text-muted-foreground/50">
              {t("tools.noDescription")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {tool.source === "user" ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              disabled={acting}
              title={t("tools.delete")}
            >
              {acting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ImportFormProps {
  name: string;
  content: string;
  onNameChange: (v: string) => void;
  onContentChange: (v: string) => void;
  onFileSelect: (file: File) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  success: string | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function ImportForm({
  name,
  content,
  onNameChange,
  onContentChange,
  onFileSelect,
  onSave,
  onCancel,
  saving,
  error,
  success,
  t,
}: ImportFormProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{t("tools.importTitle")}</h2>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t("tools.field.filename")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="my_tool.py"
              className="h-8"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              {t("tools.field.chooseFile")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".py"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFileSelect(file);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {t("tools.field.content")}
          </label>
          <textarea
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            placeholder={t("tools.field.contentPlaceholder")}
            rows={10}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
        </div>

        <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t("tools.field.hint")}
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            {error}
          </div>
        ) : null}

        {success ? (
          <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600 dark:text-green-400">
            <AlertCircle className="h-3.5 w-3.5" />
            {success}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            {t("tools.cancel")}
          </Button>
          <Button size="sm" onClick={onSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t("tools.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
