import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteAgent,
  fetchAgents,
  generateAgent,
  readAgent,
  saveAgent,
} from "@/lib/api";
import type { AgentInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

// Default template used when creating a new agent via the form.
const DEFAULT_AGENT_SYSTEM_PROMPT =
  "You are a specialized subagent. Describe your responsibilities here.";

interface AgentsViewProps {
  onBack: () => void;
  token: string;
  /** Called when the user picks "use this agent" — closes the view and starts a chat. */
  onUseAgent?: (agentId: string) => void;
}

interface CreateForm {
  name: string;
  description: string;
  model: string;
  tools: string;
  systemPrompt: string;
}

const EMPTY_FORM: CreateForm = {
  name: "",
  description: "",
  model: "",
  tools: "",
  systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
};

/** Assemble .md file content (YAML frontmatter + body) from form fields. */
function buildAgentMarkdown(form: CreateForm): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${form.name.trim()}`);
  lines.push(`description: ${form.description.trim()}`);
  if (form.model.trim()) {
    lines.push(`model: ${form.model.trim()}`);
  }
  if (form.tools.trim()) {
    lines.push(`tools: ${form.tools.trim()}`);
  }
  lines.push("---", "");
  lines.push(form.systemPrompt.trim() || DEFAULT_AGENT_SYSTEM_PROMPT);
  return lines.join("\n");
}

export function AgentsView({ onBack, token, onUseAgent }: AgentsViewProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentInfo | null>(null);

  // Create dialog (form-based)
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Edit dialog (raw .md editor, like skills)
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorName, setEditorName] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Generate dialog (AI-powered)
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateDescription, setGenerateDescription] = useState("");
  const [generateContent, setGenerateContent] = useState("");
  const [generateName, setGenerateName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateSaving, setGenerateSaving] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateStage, setGenerateStage] = useState<"input" | "preview">("input");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAgents(token);
      setAgents(data.agents);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setCreateForm(EMPTY_FORM);
    setCreateError(null);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const name = createForm.name.trim();
    if (!name) {
      setCreateError(t("agents.nameLabel") + " " + t("agents.namePlaceholder"));
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      setCreateError(t("agents.nameHelp"));
      return;
    }
    if (!createForm.description.trim()) {
      setCreateError(t("agents.descriptionField") + " " + t("agents.namePlaceholder"));
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const content = buildAgentMarkdown(createForm);
      await saveAgent(token, name, content);
      setCreateOpen(false);
      setNotice(t("agents.saved"));
      await load();
    } catch (e) {
      setCreateError(`${t("agents.saveError")}: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const openEditor = async (agent: AgentInfo) => {
    setEditorError(null);
    setEditorName(agent.name);
    setEditorContent("");
    setEditorOpen(true);
    try {
      const data = await readAgent(token, agent.name);
      setEditorContent(data.content);
    } catch (e) {
      setEditorError((e as Error).message);
    }
  };

  const handleSave = async () => {
    const name = editorName.trim();
    if (!name) {
      setEditorError(t("agents.nameLabel") + " " + t("agents.namePlaceholder"));
      return;
    }
    if (!editorContent.trim()) {
      setEditorError(t("agents.editorPlaceholder"));
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      await saveAgent(token, name, editorContent);
      setEditorOpen(false);
      setNotice(t("agents.saved"));
      await load();
    } catch (e) {
      setEditorError(`${t("agents.saveError")}: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAgent(token, deleteTarget.name);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      setDeleteTarget(null);
    }
  };

  const openGenerate = () => {
    setGenerateDescription("");
    setGenerateContent("");
    setGenerateName("");
    setGenerateError(null);
    setGenerateStage("input");
    setGenerateOpen(true);
  };

  const handleGenerate = async () => {
    const description = generateDescription.trim();
    if (!description) {
      setGenerateError(t("agents.generateDescription"));
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await generateAgent(description, token);
      setGenerateContent(result.content);
      setGenerateName(result.name);
      setGenerateStage("preview");
    } catch (e) {
      setGenerateError(`${t("agents.saveError")}: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateSave = async () => {
    const name = generateName.trim();
    if (!name || !generateContent.trim()) {
      setGenerateError(t("agents.editorPlaceholder"));
      return;
    }
    setGenerateSaving(true);
    setGenerateError(null);
    try {
      await saveAgent(token, name, generateContent);
      setGenerateOpen(false);
      setNotice(t("agents.saved"));
      await load();
    } catch (e) {
      setGenerateError(`${t("agents.saveError")}: ${(e as Error).message}`);
    } finally {
      setGenerateSaving(false);
    }
  };

  const handleUseAgent = (agentName: string) => {
    onUseAgent?.(agentName);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <Users className="h-4.5 w-4.5 text-foreground/80" />
          <h1 className="text-sm font-semibold">{t("agents.title")}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={openGenerate}
          >
            <Sparkles className="h-3 w-3 text-sky-500" />
            {t("agents.generate")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={openCreate}
          >
            <Plus className="h-3 w-3" />
            {t("agents.create")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {notice && (
          <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {loading && agents.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("agents.loading")}
          </div>
        ) : agents.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("agents.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.name}
                agent={agent}
                onEdit={() => openEditor(agent)}
                onDelete={() => setDeleteTarget(agent)}
                onUse={() => handleUseAgent(agent.name)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create dialog (form-based) */}
      <Dialog open={createOpen} onOpenChange={(o) => setCreateOpen(o)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{t("agents.create")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <FormField label={t("agents.nameLabel")} required>
              <Input
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t("agents.namePlaceholder")}
                className="h-8 text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground/60">{t("agents.nameHelp")}</p>
            </FormField>
            <FormField label={t("agents.descriptionField")} required>
              <Input
                value={createForm.description}
                onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t("agents.descriptionPlaceholder")}
                className="h-8 text-xs"
              />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t("agents.model")}>
                <Input
                  value={createForm.model}
                  onChange={(e) => setCreateForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder={t("agents.modelPlaceholder")}
                  className="h-8 text-xs font-mono"
                />
              </FormField>
              <FormField label={t("agents.tools")}>
                <Input
                  value={createForm.tools}
                  onChange={(e) => setCreateForm((f) => ({ ...f, tools: e.target.value }))}
                  placeholder={t("agents.toolsPlaceholder")}
                  className="h-8 text-xs font-mono"
                />
              </FormField>
            </div>
            <FormField label={t("agents.systemPrompt")}>
              <Textarea
                value={createForm.systemPrompt}
                onChange={(e) => setCreateForm((f) => ({ ...f, systemPrompt: e.target.value }))}
                placeholder={t("agents.systemPromptPlaceholder")}
                className="min-h-[160px] font-mono text-[11px] leading-relaxed"
              />
            </FormField>
            {createError && (
              <p className="text-[11px] text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setCreateOpen(false)}>
              {t("agents.cancel")}
            </Button>
            <Button size="sm" className="h-8" onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
              {creating ? t("agents.saving") : t("agents.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog (raw .md editor) */}
      <Dialog open={editorOpen} onOpenChange={(o) => setEditorOpen(o)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-sky-500" />
              {t("agents.edit")} · {editorName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Textarea
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              placeholder={t("agents.editorPlaceholder")}
              className="min-h-[360px] font-mono text-[11px] leading-relaxed"
            />
            {editorError && (
              <p className="text-[11px] text-destructive">{editorError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditorOpen(false)}>
              {t("agents.cancel")}
            </Button>
            <Button size="sm" className="h-8" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
              {saving ? t("agents.saving") : t("agents.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Generate dialog (AI-powered) */}
      <Dialog open={generateOpen} onOpenChange={(o) => setGenerateOpen(o)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-sky-500" />
              {t("agents.generate")}
            </DialogTitle>
          </DialogHeader>
          {generateStage === "input" ? (
            <div className="space-y-2">
              <Textarea
                value={generateDescription}
                onChange={(e) => setGenerateDescription(e.target.value)}
                placeholder={t("agents.generateDescription")}
                className="min-h-[140px] text-[12px] leading-relaxed"
                disabled={generating}
              />
              {generateError && (
                <p className="text-[11px] text-destructive">{generateError}</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea
                value={generateContent}
                onChange={(e) => setGenerateContent(e.target.value)}
                placeholder={t("agents.editorPlaceholder")}
                className="min-h-[320px] font-mono text-[11px] leading-relaxed"
              />
              {generateError && (
                <p className="text-[11px] text-destructive">{generateError}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setGenerateOpen(false)}>
              {t("agents.cancel")}
            </Button>
            {generateStage === "input" ? (
              <Button size="sm" className="h-8" onClick={handleGenerate} disabled={generating}>
                {generating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Sparkles className="mr-1.5 h-3 w-3" />}
                {generating ? t("agents.generateLoading") : t("agents.generate")}
              </Button>
            ) : (
              <Button size="sm" className="h-8" onClick={handleGenerateSave} disabled={generateSaving}>
                {generateSaving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                {generateSaving ? t("agents.saving") : t("agents.save")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AgentDeleteConfirm
        open={deleteTarget !== null}
        agentName={deleteTarget?.name ?? ""}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

/* ─── Agent Card ──────────────────────────────────────────── */

function AgentCard({
  agent,
  onEdit,
  onDelete,
  onUse,
}: {
  agent: AgentInfo;
  onEdit: () => void;
  onDelete: () => void;
  onUse: () => void;
}) {
  const { t } = useTranslation();
  const tools = agent.tools;
  return (
    <div className="group flex flex-col rounded-lg border border-border/60 bg-background px-3 py-2.5 transition-colors hover:border-sky-500/40">
      <div className="flex items-start gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Users className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium leading-tight" title={agent.name}>
            {agent.name}
          </span>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug text-muted-foreground/70">
            {agent.description || "—"}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {agent.model ? (
          <Badge className="bg-violet-500/10 text-violet-600 dark:text-violet-400">
            {agent.model}
          </Badge>
        ) : null}
        {tools === null ? (
          <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <Wrench className="mr-0.5 h-2.5 w-2.5" />
            {t("agents.allTools")}
          </Badge>
        ) : tools.length === 0 ? (
          <Badge className="bg-muted/60 text-muted-foreground/70">
            {t("agents.noTools")}
          </Badge>
        ) : (
          tools.map((tool) => (
            <Badge
              key={tool}
              className="bg-muted/60 font-mono text-muted-foreground/80"
            >
              {tool}
            </Badge>
          ))
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[10.5px] text-sky-600 hover:!bg-sky-500/10 hover:!text-sky-600 dark:text-sky-400"
          onClick={onUse}
        >
          <Sparkles className="h-3 w-3" />
          {t("agents.useAgent")}
        </Button>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton title={t("agents.edit")} onClick={onEdit}>
            <Pencil className="h-3 w-3" />
          </IconButton>
          <IconButton
            title={t("agents.delete")}
            onClick={onDelete}
            className="hover:!bg-destructive/10 hover:!text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
        className,
      )}
    >
      {children}
    </span>
  );
}

function IconButton({
  title,
  onClick,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
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

/* ─── Agent Delete Confirm Dialog ────────────────────────── */

function AgentDeleteConfirm({
  open,
  agentName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  agentName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <AlertDialogContent
        className={cn(
          "w-[min(calc(100vw-2rem),22.75rem)] gap-0 rounded-[22px] p-5 text-center",
          "border border-border bg-background shadow-[0_22px_70px_rgba(0,0,0,0.22)]",
          "dark:border-white/14 dark:bg-[#2b2b2b] dark:shadow-[0_26px_90px_rgba(0,0,0,0.44)]",
          "sm:rounded-[22px] data-[state=open]:zoom-in-95",
        )}
      >
        <AlertDialogHeader className="items-center space-y-0 text-center">
          <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-muted">
            <Users className="h-[18px] w-[18px] text-muted-foreground" strokeWidth={2} aria-hidden />
          </div>
          <AlertDialogTitle className="text-center text-[14px] font-medium leading-5 text-foreground">
            {t("agents.deleteDialogTitle", { name: agentName })}
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-2 max-w-[17rem] text-center text-[12px] leading-4 text-muted-foreground">
            {t("agents.deleteDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-5 grid grid-cols-2 gap-2.5 space-x-0">
          <AlertDialogCancel
            onClick={onCancel}
            className="mt-0 h-10 rounded-[11px] border-0 bg-muted px-4 text-[14px] font-medium text-foreground shadow-none hover:bg-muted/80"
          >
            {t("agents.deleteCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="h-10 rounded-[11px] bg-foreground px-4 text-[14px] font-medium text-background shadow-none hover:bg-foreground/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
          >
            {t("agents.deleteConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
