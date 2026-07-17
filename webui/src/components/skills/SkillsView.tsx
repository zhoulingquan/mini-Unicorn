import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Eye,
  FileCode,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
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
import { ErrorBanner, NoticeBanner } from "@/components/ui/banner";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteSkill,
  fetchSkills,
  readSkill,
  readSkillFile,
  saveSkill,
  toggleSkill,
  uploadSkillZip,
} from "@/lib/api";
import type { SkillDetail, SkillInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

type SkillTFunc = (key: string, options?: Record<string, unknown>) => string;

/** 技能卡片描述的 i18n helper。
 * 查找顺序：skills.skillDescriptions.{name} → 后端 skill.description */
function useSkillDescription() {
  const { t } = useTranslation();
  return (skill: SkillInfo): string => {
    const translated = t(`skills.skillDescriptions.${skill.name}`, {
      defaultValue: "",
    });
    return translated || skill.description;
  };
}

function buildSkillTemplate(t: SkillTFunc): string {
  return `---
name: my-skill
description: ${t("skills.template.description")}
---

# My Skill

${t("skills.template.body")}
`;
}

interface SkillsViewProps {
  onBack: () => void;
  token: string;
}

export function SkillsView({ onBack, token }: SkillsViewProps) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillInfo | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("grid");

  // Detail modal
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  const [detailFile, setDetailFile] = useState<{ path: string; content: string } | null>(null);
  const [detailFileLoading, setDetailFileLoading] = useState<string | null>(null);

  // Editor modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorName, setEditorName] = useState("");
  const [editorContent, setEditorContent] = useState(() => buildSkillTemplate(t));
  const [editorIsBuiltin, setEditorIsBuiltin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Upload
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSkills(token);
      setSkills(data.skills);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = async (skill: SkillInfo) => {
    setToggling(skill.name);
    try {
      await toggleSkill(token, skill.name, !skill.disabled);
      setSkills((prev) =>
        prev.map((s) => (s.name === skill.name ? { ...s, disabled: !s.disabled } : s)),
      );
    } catch (e) {
      setError(`${t("skills.toggleError")}: ${(e as Error).message}`);
    } finally {
      setToggling(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSkill(token, deleteTarget.name);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      setDeleteTarget(null);
    }
  };

  const openDetail = async (skill: SkillInfo) => {
    setDetailLoading(skill.name);
    setDetailFile(null);
    try {
      const data = await readSkill(token, skill.name);
      setDetail(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetailLoading(null);
    }
  };

  const openDetailFile = async (skillName: string, path: string) => {
    if (path === "SKILL.md" && detail) {
      setDetailFile({ path, content: detail.content });
      return;
    }
    setDetailFileLoading(path);
    try {
      const data = await readSkillFile(token, skillName, path);
      setDetailFile({ path: data.path, content: data.content });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetailFileLoading(null);
    }
  };

  const openEditor = (skill?: SkillInfo) => {
    setEditorError(null);
    if (skill) {
      setEditorName(skill.name);
      setEditorIsBuiltin(skill.builtin_only);
      // Load content into the editor.
      void (async () => {
        try {
          const data = await readSkill(token, skill.name);
          setEditorContent(data.content);
          setEditorIsBuiltin(data.builtin_only);
        } catch (e) {
          setEditorError((e as Error).message);
        }
      })();
    } else {
      setEditorName("");
      setEditorContent(buildSkillTemplate(t));
      setEditorIsBuiltin(false);
    }
    setEditorOpen(true);
  };

  const handleSave = async () => {
    const name = editorName.trim();
    if (!name) {
      setEditorError(t("skills.nameLabel") + " " + t("skills.namePlaceholder"));
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      setEditorError(t("skills.nameHelp"));
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      await saveSkill(token, name, editorContent);
      setEditorOpen(false);
      setNotice(t("skills.saved"));
      await load();
    } catch (e) {
      setEditorError(`${t("skills.saveError")}: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleUploadPick = () => {
    fileInputRef.current?.click();
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setNotice(null);
    setError(null);
    try {
      const result = await uploadSkillZip(token, file);
      setNotice(t("skills.uploadSuccess", { name: result.name }));
      await load();
    } catch (e) {
      setError(`${t("skills.uploadFailed")}: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailLoading(null);
    setDetailFile(null);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <Sparkles className="h-4.5 w-4.5 text-foreground/80" />
          <h1 className="text-sm font-semibold">{t("skills.title")}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={handleUploadFile}
          />
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
              title={t("skills.listView")}
              aria-label={t("skills.listView")}
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
              title={t("skills.gridView")}
              aria-label={t("skills.gridView")}
              aria-pressed={viewMode === "grid"}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={handleUploadPick}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
            {uploading ? t("skills.uploading") : t("skills.upload")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[11px]"
            onClick={() => openEditor()}
          >
            <Plus className="h-3 w-3" />
            {t("skills.create")}
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
          <NoticeBanner className="mb-3">{notice}</NoticeBanner>
        )}
        {error && (
          <ErrorBanner className="mb-3">{error}</ErrorBanner>
        )}

        {loading && skills.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("skills.loading")}
          </div>
        ) : skills.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("skills.empty")}
          </div>
        ) : (
          <div className={cn(viewMode === "grid" ? "grid grid-cols-4 gap-1.5" : "mx-auto flex w-full max-w-2xl flex-col gap-2.5")}>
            {skills.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                viewMode={viewMode}
                toggling={toggling === skill.name}
                onToggle={() => handleToggle(skill)}
                onView={() => openDetail(skill)}
                onEdit={() => openEditor(skill)}
                onDelete={() => setDeleteTarget(skill)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail modal */}
      <Dialog open={detail !== null || detailLoading !== null} onOpenChange={(o) => (!o ? closeDetail() : undefined)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-violet-500" />
              {detailLoading ? t("skills.loading") : detail ? detail.name : ""}
            </DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("skills.loading")}
            </div>
          ) : detail ? (
            <DetailBody
              detail={detail}
              detailFile={detailFile}
              detailFileLoading={detailFileLoading}
              onOpenFile={(path) => openDetailFile(detail.name, path)}
              onCloseFile={() => setDetailFile(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Editor modal */}
      <Dialog open={editorOpen} onOpenChange={(o) => setEditorOpen(o)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{t("skills.editorTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                {t("skills.nameLabel")}
              </label>
              <Input
                value={editorName}
                onChange={(e) => setEditorName(e.target.value)}
                placeholder={t("skills.namePlaceholder")}
                className="h-8 text-xs"
                disabled={editorIsBuiltin}
              />
              <p className="mt-1 text-[10px] text-muted-foreground/60">{t("skills.nameHelp")}</p>
              {editorIsBuiltin && (
                <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                  {t("skills.builtinReadonly")}
                </p>
              )}
            </div>
            <Textarea
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              placeholder={t("skills.editorPlaceholder")}
              className="min-h-[320px] font-mono text-[11px] leading-relaxed"
            />
            {editorError && (
              <p className="text-[11px] text-destructive">{editorError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditorOpen(false)}>
              {t("skills.cancel")}
            </Button>
            <Button size="sm" className="h-8" onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              ) : null}
              {saving ? t("skills.saving") : t("skills.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SkillDeleteConfirm
        open={deleteTarget !== null}
        skillName={deleteTarget?.name ?? ""}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

/* ─── Skill Card ───────────────────────────────────────────── */

function SkillCard({
  skill,
  viewMode,
  toggling,
  onToggle,
  onView,
  onEdit,
  onDelete,
}: {
  skill: SkillInfo;
  viewMode: "list" | "grid";
  toggling: boolean;
  onToggle: () => void;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const getSkillDescription = useSkillDescription();
  const iconColor = pickSkillColor(skill.name);
  return (
    <div
      className={cn(
        "group flex flex-col transition-colors",
        viewMode === "grid"
          ? "rounded-lg border px-2.5 py-2"
          : "rounded-xl border bg-card px-3.5 py-3 shadow-sm",
        skill.disabled
          ? "border-muted/60 bg-muted/20 opacity-70"
          : skill.available
            ? viewMode === "grid"
              ? "border-border/60 bg-background hover:border-violet-500/40"
              : "border-border/60 hover:bg-accent/20"
            : "border-amber-500/30 bg-amber-500/[0.03]",
      )}
    >
      <div className="flex items-start gap-2">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-bold text-white"
          style={{ backgroundColor: iconColor }}
        >
          {skill.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-medium leading-tight" title={skill.name}>
              {skill.name}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {skill.disabled ? (
              <Badge className="bg-muted/60 text-muted-foreground/70">{t("skills.disabled")}</Badge>
            ) : skill.available ? (
              <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                {t("skills.enabled")}
              </Badge>
            ) : (
              <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                {t("skills.unavailable")}
              </Badge>
            )}
            {skill.always && !skill.disabled && (
              <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400">{t("skills.always")}</Badge>
            )}
            <Badge
              className={
                skill.source === "workspace"
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "bg-muted/60 text-muted-foreground/50"
              }
            >
              {skill.source === "workspace" ? t("skills.workspaceBadge") : t("skills.builtinBadge")}
            </Badge>
          </div>
        </div>
        <ToggleSwitch
          checked={!skill.disabled}
          disabled={toggling}
          onClick={onToggle}
          ariaLabel={skill.disabled ? t("skills.enable") : t("skills.disable")}
        />
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
        {getSkillDescription(skill) || "—"}
      </p>

      <div className="mt-2 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton title={t("skills.viewDetails")} onClick={onView}>
          <Eye className="h-3 w-3" />
        </IconButton>
        <IconButton title={t("skills.edit")} onClick={onEdit}>
          <Pencil className="h-3 w-3" />
        </IconButton>
        {skill.source === "workspace" && (
          <IconButton
            title={t("skills.deleteTitle")}
            onClick={onDelete}
            className="hover:!bg-destructive/10 hover:!text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

const SKILL_PALETTE = [
  "#3B82F6", // blue
  "#8B5CF6", // violet
  "#10B981", // emerald
  "#F59E0B", // amber
  "#EF4444", // red
  "#0EA5E9", // sky
  "#EC4899", // pink
  "#14B8A6", // teal
];

function pickSkillColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return SKILL_PALETTE[Math.abs(hash) % SKILL_PALETTE.length];
}

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
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

/* ─── Detail Body ──────────────────────────────────────────── */

function DetailBody({
  detail,
  detailFile,
  detailFileLoading,
  onOpenFile,
  onCloseFile,
}: {
  detail: SkillDetail;
  detailFile: { path: string; content: string } | null;
  detailFileLoading: string | null;
  onOpenFile: (path: string) => void;
  onCloseFile: () => void;
}) {
  const { t } = useTranslation();
  const otherFiles = detail.files.filter((f) => f !== "SKILL.md");
  const showing = detailFile?.path ?? "SKILL.md";
  const showingContent = detailFile ? detailFile.content : detail.content;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="w-40 shrink-0 space-y-0.5">
          <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            {t("skills.files")}
          </p>
          <FileButton
            path="SKILL.md"
            active={showing === "SKILL.md"}
            onClick={() => onOpenFile("SKILL.md")}
          />
          {otherFiles.length === 0 ? (
            <p className="px-1 py-1 text-[10px] text-muted-foreground/40">{t("skills.noFiles")}</p>
          ) : (
            otherFiles.map((f) => (
              <FileButton
                key={f}
                path={f}
                active={showing === f}
                onClick={() => onOpenFile(f)}
              />
            ))
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <FileCode className="h-3 w-3" />
              {showing}
            </span>
            {detailFile && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onCloseFile}>
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          {detailFileLoading ? (
            <div className="flex items-center justify-center rounded-md border bg-muted/30 py-6 text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              {t("skills.loading")}
            </div>
          ) : (
            <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed">
              <code className="font-mono whitespace-pre-wrap break-words">{showingContent}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function FileButton({
  path,
  active,
  onClick,
}: {
  path: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1 truncate rounded px-1.5 py-1 text-left text-[11px] transition-colors",
        active ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : "hover:bg-muted text-muted-foreground",
      )}
      title={path}
    >
      <FileCode className="h-3 w-3 shrink-0" />
      <span className="truncate">{path}</span>
    </button>
  );
}

/* ─── Skill Delete Confirm Dialog ─────────────────────────── */

function SkillDeleteConfirm({
  open,
  skillName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  skillName: string;
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
            <Sparkles className="h-[18px] w-[18px] text-muted-foreground" strokeWidth={2} aria-hidden />
          </div>
          <AlertDialogTitle className="text-center text-[14px] font-medium leading-5 text-foreground">
            {t("skills.deleteDialogTitle", { name: skillName })}
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-2 max-w-[17rem] text-center text-[12px] leading-4 text-muted-foreground">
            {t("skills.deleteDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-5 grid grid-cols-2 gap-2.5 space-x-0">
          <AlertDialogCancel
            onClick={onCancel}
            className="mt-0 h-10 rounded-[11px] border-0 bg-muted px-4 text-[14px] font-medium text-foreground shadow-none hover:bg-muted/80"
          >
            {t("skills.deleteCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="h-10 rounded-[11px] bg-foreground px-4 text-[14px] font-medium text-background shadow-none hover:bg-foreground/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
          >
            {t("skills.deleteConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
