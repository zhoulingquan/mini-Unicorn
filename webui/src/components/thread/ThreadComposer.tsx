import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { MarkdownText, preloadMarkdownText } from "@/components/MarkdownText";
import {
  Activity,
  ArrowUp,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  FileText,
  History,
  ImageIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  Shield,
  Sparkles,
  Square,
  SquarePen,
  Target,
  Undo2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  WorkspaceAccessMenu,
  WorkspaceProjectPicker,
} from "@/components/thread/WorkspaceControls";
import {
  useAttachedImages,
  type AttachedImage,
  type AttachmentError,
  DOCUMENT_EXTENSIONS,
  MAX_IMAGES_PER_MESSAGE,
} from "@/hooks/useAttachedImages";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import type { SendImage, SendOptions } from "@/hooks/useMiniUnicornStream";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  AgentInfo,
  ContextUsagePayload,
  GoalStateWsPayload,
  SlashCommand,
  WorkspaceScopePayload,
  WorkspacesPayload,
} from "@/lib/types";
import { inferProviderFromModelName, providerBrand } from "@/lib/provider-brand";
import { cn } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage";

/** ``<input accept>``:与后端 MIME 白名单对齐。图片走 image worker,
 * 文档走直接 base64 路径。SVG 被刻意排除以避免嵌入式脚本的 XSS 风险。 */
const ACCEPT_ATTR =
  "image/png,image/jpeg,image/webp,image/gif," +
  "application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "application/vnd.openxmlformats-officedocument.presentationml.presentation," +
  "text/plain,text/markdown,text/csv," +
  "application/json,application/xml,text/xml,text/html," +
  "application/x-yaml,text/yaml," +
  "application/octet-stream," +
  DOCUMENT_EXTENSIONS;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface ThreadComposerProps {
  onSend: (content: string, images?: SendImage[], options?: SendOptions) => void;
  disabled?: boolean;
  placeholder?: string;
  isStreaming?: boolean;
  modelLabel?: string | null;
  modelProvider?: string | null;
  modelProviderLabel?: string | null;
  variant?: "thread" | "hero";
  slashCommands?: SlashCommand[];
  onStop?: () => void;
  /** Unix seconds from server; turn elapsed timer above input while set. */
  runStartedAt?: number | null;
  /** Sustained objective for this chat (WebSocket ``goal_state``). */
  goalState?: GoalStateWsPayload;
  workspaceScope?: WorkspaceScopePayload | null;
  workspaceDefaultScope?: WorkspaceScopePayload | null;
  workspaceControls?: WorkspacesPayload["controls"] | null;
  workspaceScopeDisabled?: boolean;
  workspaceError?: string | null;
  onWorkspaceScopeChange?: (scope: WorkspaceScopePayload) => void;
  /** Subagents available for ``@agent`` selection (from ``GET /api/agents``). */
  agents?: AgentInfo[];
  /** Currently selected subagent id (``agent.name``); routes outbound turns. */
  selectedAgentId?: string | null;
  /** Called when the user picks a subagent from the selector. */
  onSelectAgent?: (agentId: string) => void;
  /** Called when the user clears the active subagent selection. */
  onClearAgent?: () => void;
  /** 当前会话消息条数(含 user/assistant,不含 trace 行)。 */
  messageCount?: number;
  /** 当前模型预设的上下文窗口大小(tokens),用于显示上下文预算。 */
  contextWindowTokens?: number | null;
  /** 最近一轮对话最后一次 LLM 调用的 token usage(从 turn_end 推送)。 */
  contextUsage?: ContextUsagePayload | null;
  /** Session key used to reset per-conversation refs (e.g. chipRefs) on switch. */
  conversationKey?: string | null;
}

const COMMAND_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  "book-open": BookOpen,
  brain: Brain,
  "circle-help": CircleHelp,
  history: History,
  "rotate-cw": RotateCw,
  shield: Shield,
  sparkles: Sparkles,
  square: Square,
  "square-pen": SquarePen,
  "undo-2": Undo2,
};

const SLASH_PALETTE_GAP_PX = 8;
const SLASH_PALETTE_MAX_HEIGHT_PX = 288;
const SLASH_PALETTE_MIN_HEIGHT_PX = 144;
const SLASH_PALETTE_CHROME_PX = 12;
const SLASH_RECENTS_STORAGE_KEY = STORAGE_KEYS.slashCommandRecents;
const SLASH_RECENTS_LIMIT = 5;

type SlashPalettePlacement = "above" | "below";

interface SlashPaletteLayout {
  placement: SlashPalettePlacement;
  maxHeight: number;
}

interface SlashPaletteCommand extends SlashCommand {
  detail: string;
  badge?: string;
  recent: boolean;
}

function slashCommandI18nKey(command: string): string {
  return command.replace(/^\//, "").replace(/-/g, "_");
}

function readSlashRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SLASH_RECENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, SLASH_RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function storeSlashRecents(commands: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SLASH_RECENTS_STORAGE_KEY,
      JSON.stringify(commands.slice(0, SLASH_RECENTS_LIMIT)),
    );
  } catch {
    // localStorage may be unavailable in private contexts; command insertion still works.
  }
}

function getVisibleBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  let parent = el.parentElement;

  while (parent) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      const rect = parent.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    parent = parent.parentElement;
  }

  return { top, bottom };
}

function goalStateStripPreview(
  goal: GoalStateWsPayload | undefined,
  t: (key: string) => string,
): string | null {
  if (!goal?.active) return null;
  const summary = goal.ui_summary?.trim();
  if (summary) return summary;
  const obj = goal.objective?.trim();
  if (obj) return obj.length > 72 ? `${obj.slice(0, 72)}…` : obj;
  return t("thread.composer.goalStateFallback");
}

const GOAL_PANEL_VIEWPORT_TOP_PAD = 20;
const GOAL_PANEL_GAP_ABOVE_STRIP_PX = 10;
const GOAL_PANEL_MIN_HEIGHT_PX = 112;
const GOAL_PANEL_MAX_VIEWPORT_RATIO = 0.62;

function measureGoalPanelMaxCssHeight(stripTopY: number): number {
  const spaceAboveStrip =
    stripTopY - GOAL_PANEL_VIEWPORT_TOP_PAD - GOAL_PANEL_GAP_ABOVE_STRIP_PX;
  return Math.min(
    Math.max(spaceAboveStrip, GOAL_PANEL_MIN_HEIGHT_PX),
    Math.floor(window.innerHeight * GOAL_PANEL_MAX_VIEWPORT_RATIO),
  );
}

function buildGoalMarkdownBody(summary: string, objective: string): string {
  const s = summary.trim();
  const o = objective.trim();
  if (s && o) return `${s}\n\n---\n\n${o}`;
  return o || s;
}

function RunElapsedStrip({
  startedAt,
  goalState,
}: {
  startedAt: number | null;
  goalState?: GoalStateWsPayload;
}) {
  const { t } = useTranslation();
  const [goalPanelOpen, setGoalPanelOpen] = useState(false);
  const [, setTick] = useState(0);
  const stripWrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const expandToggleRef = useRef<HTMLButtonElement>(null);
  const [panelMaxPx, setPanelMaxPx] = useState(280);

  useEffect(() => {
    if (startedAt == null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const showTimer = startedAt != null;
  const stripLabel = goalStateStripPreview(goalState, t);
  const showGoal = !!stripLabel?.trim();

  const objectiveFull = goalState?.objective?.trim() ?? "";
  const summaryFull = goalState?.ui_summary?.trim() ?? "";
  const canExpandGoal = !!(goalState?.active && (objectiveFull || summaryFull));

  const markdownBody =
    objectiveFull || summaryFull
      ? buildGoalMarkdownBody(summaryFull, objectiveFull)
      : "";

  useLayoutEffect(() => {
    if (!goalPanelOpen) return;

    function relayout(): void {
      const el = stripWrapperRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setPanelMaxPx(measureGoalPanelMaxCssHeight(top));
    }

    relayout();

    preloadMarkdownText();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => relayout())
        : null;
    if (stripWrapperRef.current && ro) {
      ro.observe(stripWrapperRef.current);
    }
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", relayout, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", relayout, true);
    };
  }, [goalPanelOpen]);

  useEffect(() => {
    if (!goalPanelOpen) return;

    function onPointerDown(ev: MouseEvent): void {
      const target = ev.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (expandToggleRef.current?.contains(target)) return;
      setGoalPanelOpen(false);
    }

    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") setGoalPanelOpen(false);
    }

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [goalPanelOpen]);

  if (!showTimer && !showGoal) return null;

  const elapsed =
    startedAt != null ? Math.max(0, Math.floor(Date.now() / 1000 - startedAt)) : 0;
  const m = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const shortElapsed = m > 0 ? `${m}:${sec.toString().padStart(2, "0")}` : `${sec}s`;
  const timerTitle = showTimer
    ? t("thread.composer.runRuntimeTitle", { elapsed: shortElapsed })
    : null;

  const ariaParts = [timerTitle, showGoal ? stripLabel : null].filter(Boolean);
  const ariaLabel = ariaParts.join(" · ");

  return (
    <div ref={stripWrapperRef} className="relative z-30">
      {goalPanelOpen && canExpandGoal && markdownBody ? (
        <div
          ref={panelRef}
          id="miniUnicorn-goal-panel-root"
          role="dialog"
          aria-modal="false"
          aria-labelledby="miniUnicorn-goal-panel-title"
          tabIndex={-1}
          className={cn(
            "absolute bottom-[calc(100%+8px)] left-3 right-3 z-[50] flex max-w-none flex-col overflow-hidden",
            "rounded-2xl border border-black/[0.08] bg-card shadow-[0_12px_40px_rgba(15,23,42,0.14)]",
            "backdrop-blur-sm dark:border-white/[0.1] dark:shadow-[0_16px_48px_rgba(0,0,0,0.45)]",
          )}
          style={{ maxHeight: `${Math.round(panelMaxPx)}px` }}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.08]">
            <h2
              id="miniUnicorn-goal-panel-title"
              className="min-w-0 truncate text-[13px] font-semibold tracking-tight text-foreground"
            >
              {t("thread.composer.goalStateSheetTitle")}
            </h2>
            <button
              type="button"
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                "text-muted-foreground transition-colors hover:bg-muted/65 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label={t("thread.composer.goalStateCloseAria")}
              onClick={() => setGoalPanelOpen(false)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div
            id="miniUnicorn-goal-panel-scroll"
            className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-3 pb-3 pt-2"
          >
            <MarkdownText className="max-w-none text-[13.5px] leading-relaxed text-foreground/90">
              {markdownBody}
            </MarkdownText>
          </div>
        </div>
      ) : null}
      <div
        className="flex min-h-[36px] items-center gap-2 border-b border-black/[0.04] px-3 py-2 dark:border-white/[0.06]"
        role="status"
        aria-label={ariaLabel}
      >
        {showTimer ? (
          <Activity className="h-4 w-4 shrink-0 text-primary/80" aria-hidden />
        ) : (
          <Target className="h-4 w-4 shrink-0 text-primary/75" aria-hidden />
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] font-medium text-foreground/75">
          {timerTitle ? <span className="shrink-0">{timerTitle}</span> : null}
          {timerTitle && showGoal ? (
            <span className="shrink-0 text-muted-foreground/45" aria-hidden>
              ·
            </span>
          ) : null}
          {showGoal ? (
            <span className="truncate">
              {t("thread.composer.goalStateStrip", { label: stripLabel })}
            </span>
          ) : null}
        </span>
        {canExpandGoal ? (
          <button
            ref={expandToggleRef}
            type="button"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
              "text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-expanded={goalPanelOpen}
            aria-controls={goalPanelOpen ? "miniUnicorn-goal-panel-root" : undefined}
            aria-label={t("thread.composer.goalStateExpandAria")}
            title={t("thread.composer.goalStateExpandAria")}
            onClick={() => setGoalPanelOpen((o) => !o)}
          >
            {goalPanelOpen ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronUp className="h-4 w-4" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ThreadComposer({
  onSend,
  disabled,
  placeholder,
  isStreaming = false,
  modelLabel = null,
  modelProvider = null,
  modelProviderLabel = null,
  variant = "thread",
  slashCommands = [],
  onStop,
  runStartedAt = null,
  goalState,
  workspaceScope = null,
  workspaceDefaultScope = null,
  workspaceControls = null,
  workspaceScopeDisabled = false,
  workspaceError = null,
  onWorkspaceScopeChange,
  agents = [],
  selectedAgentId = null,
  onSelectAgent,
  onClearAgent,
  messageCount = 0,
  contextWindowTokens = null,
  contextUsage = null,
  conversationKey = null,
}: ThreadComposerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [recentSlashCommands, setRecentSlashCommands] = useState<string[]>(() => readSlashRecents());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastConversationKeyRef = useRef<string | null>(conversationKey);

  useEffect(() => {
    if (lastConversationKeyRef.current === conversationKey) return;
    lastConversationKeyRef.current = conversationKey;
    chipRefs.current.clear();
  }, [conversationKey]);

  const isHero = variant === "hero";
  const showProjectPicker =
    isHero
    && !!workspaceDefaultScope
    && !!onWorkspaceScopeChange
    && workspaceControls?.can_change_project !== false;

  const resolvedPlaceholder = isStreaming
    ? t("thread.composer.placeholderStreaming")
    : placeholder ?? t("thread.composer.placeholderThread");

  const { images, enqueue, remove, clear, encoding, full } =
    useAttachedImages();

  const formatRejection = useCallback(
    (reason: AttachmentError): string => {
      const key = `thread.composer.imageRejected.${reason}`;
      return t(key, { max: MAX_IMAGES_PER_MESSAGE });
    },
    [t],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const { rejected } = enqueue(files);
      if (rejected.length > 0) {
        setInlineError(formatRejection(rejected[0].reason));
      } else {
        setInlineError(null);
      }
    },
    [enqueue, formatRejection],
  );

  const {
    isDragging,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  } = useClipboardAndDrop(addFiles);

  useEffect(() => {
    if (disabled) return;
    const el = textareaRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => el.focus());
    return () => cancelAnimationFrame(id);
  }, [disabled]);

  // 展开/收起时重新调整输入框高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxH = expanded ? 400 : 260;
    const minH = expanded ? 200 : 0;
    el.style.height = `${Math.max(minH, Math.min(el.scrollHeight, maxH))}px`;
  }, [expanded]);

  const readyImages = useMemo(
    () => images.filter((img): img is AttachedImage & { dataUrl: string } =>
      img.status === "ready" && typeof img.dataUrl === "string",
    ),
    [images],
  );
  const hasErrors = images.some((img) => img.status === "error");

  const canSend =
    !disabled
    && !encoding
    && !hasErrors
    && (value.trim().length > 0 || readyImages.length > 0);

  // Resolve the active subagent object (if any) for the chip + send metadata.
  const selectedAgent = useMemo(
    () =>
      selectedAgentId
        ? agents.find((agent) => agent.name === selectedAgentId) ?? null
        : null,
    [agents, selectedAgentId],
  );
  const showAgentSelector = agents.length > 0;
  const handleSelectAgent = useCallback(
    (agentId: string) => {
      // Sentinel emitted by the "clear" menu item: delegate to onClearAgent
      // so callers only need to implement the clear path once.
      if (agentId === "__none__") {
        onClearAgent?.();
        return;
      }
      onSelectAgent?.(agentId);
    },
    [onClearAgent, onSelectAgent],
  );
  const handleClearAgent = useCallback(() => {
    onClearAgent?.();
  }, [onClearAgent]);

  const slashQuery = useMemo(() => {
    if (disabled || slashMenuDismissed || !value.startsWith("/")) return null;
    const commandToken = value.slice(1);
    if (/\s/.test(commandToken)) return null;
    return commandToken.toLowerCase();
  }, [disabled, slashMenuDismissed, value]);

  const visibleSlashCommands = useMemo(() => {
    const baseCommands = slashCommands.filter((command) => command.command !== "/stop");
    if (!(isStreaming && onStop)) return baseCommands;
    const stopCommand = slashCommands.find((command) => command.command === "/stop") ?? {
      command: "/stop",
      title: "Stop current task",
      description: "Cancel the active agent turn for this chat.",
      icon: "square",
    };
    return [
      stopCommand,
      ...baseCommands,
    ];
  }, [isStreaming, onStop, slashCommands]);

  const filteredSlashCommands = useMemo<SlashPaletteCommand[]>(() => {
    if (slashQuery === null) return [];
    const withDetails = visibleSlashCommands
      .filter((command) => {
        const commandKey = slashCommandI18nKey(command.command);
        const title = t(`thread.composer.slash.commands.${commandKey}.title`, {
          defaultValue: command.title,
        });
        const description = t(`thread.composer.slash.commands.${commandKey}.description`, {
          defaultValue: command.description,
        });
        const haystack = [
          command.command,
          command.title,
          command.description,
          command.argHint ?? "",
          title,
          description,
        ].join(" ").toLowerCase();
        return haystack.includes(slashQuery);
      })
      .map((command) => {
        const commandKey = slashCommandI18nKey(command.command);
        const description = t(`thread.composer.slash.commands.${commandKey}.description`, {
          defaultValue: command.description,
        });
        let detail = description;
        let badge: string | undefined;
        if (command.command === "/model" && modelLabel) {
          detail = modelLabel;
          badge = t("thread.composer.slash.badges.current");
        } else if (command.command === "/goal") {
          detail = goalState?.active
            ? t("thread.composer.slash.details.goalActive")
            : t("thread.composer.slash.details.goalReady");
        } else if (command.command === "/stop" && isStreaming) {
          detail = t("thread.composer.slash.details.stopRunning");
        } else if (command.command === "/history") {
          detail = t("thread.composer.slash.details.history");
        }
        return {
          ...command,
          detail,
          badge,
          recent: recentSlashCommands.includes(command.command),
        };
      })
      .sort((a, b) => {
        if (isStreaming) {
          if (a.command === "/stop") return -1;
          if (b.command === "/stop") return 1;
        }
        if (slashQuery !== "") return 0;
        const aRecent = recentSlashCommands.indexOf(a.command);
        const bRecent = recentSlashCommands.indexOf(b.command);
        if (aRecent !== -1 || bRecent !== -1) {
          if (aRecent === -1) return 1;
          if (bRecent === -1) return -1;
          return aRecent - bRecent;
        }
        return 0;
      });

    return withDetails
      .slice(0, 8);
  }, [goalState?.active, isStreaming, modelLabel, recentSlashCommands, slashQuery, t, visibleSlashCommands]);

  const showSlashMenu = filteredSlashCommands.length > 0;
  const showAnyPalette = showSlashMenu;
  const [slashPaletteLayout, setSlashPaletteLayout] = useState<SlashPaletteLayout>({
    placement: "above",
    maxHeight: SLASH_PALETTE_MAX_HEIGHT_PX,
  });

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (selectedCommandIndex >= filteredSlashCommands.length) {
      setSelectedCommandIndex(0);
    }
  }, [filteredSlashCommands.length, selectedCommandIndex]);

  useEffect(() => {
    if (!showAnyPalette) return;

    const dismissOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && formRef.current?.contains(target)) return;
      setSlashMenuDismissed(true);
    };

    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
    };
  }, [showAnyPalette]);

  useLayoutEffect(() => {
    if (!showAnyPalette) return;

    const updateLayout = () => {
      const form = formRef.current;
      if (!form) return;
      const rect = form.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const bounds = getVisibleBounds(form);
      const spaceAbove = Math.max(0, rect.top - bounds.top - SLASH_PALETTE_GAP_PX);
      const spaceBelow = Math.max(0, bounds.bottom - rect.bottom - SLASH_PALETTE_GAP_PX);
      const placement: SlashPalettePlacement =
        spaceAbove >= SLASH_PALETTE_MIN_HEIGHT_PX || spaceAbove >= spaceBelow
          ? "above"
          : "below";
      const available = placement === "above" ? spaceAbove : spaceBelow;
      const maxHeight = Math.min(SLASH_PALETTE_MAX_HEIGHT_PX, available);

      setSlashPaletteLayout((current) =>
        current.placement === placement && current.maxHeight === maxHeight
          ? current
          : { placement, maxHeight },
      );
    };

    updateLayout();
    window.addEventListener("resize", updateLayout);
    document.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      document.removeEventListener("scroll", updateLayout, true);
    };
  }, [filteredSlashCommands.length, showAnyPalette]);

  const resizeTextarea = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      const maxH = expanded ? 400 : 260;
      const minH = expanded ? 200 : 0;
      el.style.height = `${Math.max(minH, Math.min(el.scrollHeight, maxH))}px`;
      el.focus();
    });
  }, [expanded]);

  const chooseSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.command === "/stop" && isStreaming && onStop) {
        onStop();
        setValue("");
        setSlashMenuDismissed(true);
        setInlineError(null);
        resizeTextarea();
        return;
      }

      const nextRecents = [
        command.command,
        ...recentSlashCommands.filter((item) => item !== command.command),
      ].slice(0, SLASH_RECENTS_LIMIT);
      setRecentSlashCommands(nextRecents);
      storeSlashRecents(nextRecents);

      setValue(command.argHint ? `${command.command} ` : command.command);
      setSlashMenuDismissed(true);
      setInlineError(null);
      resizeTextarea();
    },
    [isStreaming, onStop, recentSlashCommands, resizeTextarea],
  );

  const submit = useCallback(() => {
    if (!canSend) return;
    const trimmed = value.trim();
    // Share the same normalized ``data:`` URL with both the wire payload and
    // the optimistic bubble preview: data URLs are self-contained (no blob
    // lifetime, safe under React StrictMode double-mount) and keep the
    // bubble in sync with whatever the backend actually sees.
    const payload: SendImage[] | undefined =
      readyImages.length > 0
        ? readyImages.map((img) => ({
            media: {
              data_url: img.dataUrl,
              name: img.file.name,
            },
            preview: { url: img.dataUrl, name: img.file.name },
          }))
        : undefined;
    const options: SendOptions | undefined = selectedAgentId
      ? { agentId: selectedAgentId }
      : undefined;
    onSend(trimmed, payload, options);
    setValue("");
    setInlineError(null);
    clear();
    setSlashMenuDismissed(false);
    resizeTextarea();
  }, [
    canSend,
    clear,
    onSend,
    readyImages,
    resizeTextarea,
    selectedAgentId,
    value,
  ]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedCommandIndex((idx) => (idx + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedCommandIndex(
          (idx) => (idx - 1 + filteredSlashCommands.length) % filteredSlashCommands.length,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        chooseSlashCommand(filteredSlashCommands[selectedCommandIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      // 展开模式下回车不提交,改为换行,方便输入大段文字
      if (expanded) return;
      e.preventDefault();
      submit();
    }
  };

  const onInput: React.FormEventHandler<HTMLTextAreaElement> = (e) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    const maxH = expanded ? 400 : 260;
    const minH = expanded ? 200 : 0;
    el.style.height = `${Math.max(minH, Math.min(el.scrollHeight, maxH))}px`;
  };

  const onFilePick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    addFiles(files);
  };

  const removeChip = useCallback(
    (id: string) => {
      const { nextFocusId } = remove(id);
      setInlineError(null);
      requestAnimationFrame(() => {
        const el = nextFocusId ? chipRefs.current.get(nextFocusId) : null;
        if (el) {
          el.focus();
        } else {
          textareaRef.current?.focus();
        }
      });
    },
    [remove],
  );

  const onChipKey = useCallback(
    (id: string) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (
        e.key === "Delete" ||
        e.key === "Backspace" ||
        e.key === "Enter" ||
        e.key === " "
      ) {
        e.preventDefault();
        removeChip(id);
      }
    },
    [removeChip],
  );

  const attachButtonDisabled = disabled || full;
  const showStopButton = isStreaming && !!onStop;
  const centerHeroPlaceholder =
    isHero && value.length === 0 && images.length === 0 && !isStreaming;
  const inputTextClasses = cn(
    "w-full resize-none bg-transparent",
    isHero
      ? cn(
          "min-h-[60px] px-4 text-[14px] leading-5",
          centerHeroPlaceholder ? "pb-2 pt-5" : "pb-1.5 pt-3",
        )
      : "min-h-[42px] px-3.5 pb-1.5 pt-2.5 text-[13px] leading-5",
    expanded && "pr-10",
  );

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn("relative w-full", isHero ? "px-0" : "px-1 pb-1.5 pt-1 sm:px-0")}
    >
      {showSlashMenu ? (
        <SlashCommandPalette
          commands={filteredSlashCommands}
          selectedIndex={selectedCommandIndex}
          layout={slashPaletteLayout}
          isHero={isHero}
          onHover={setSelectedCommandIndex}
          onChoose={chooseSlashCommand}
        />
      ) : null}
      <div
        className={cn(
          "group/composer relative mx-auto flex w-full flex-col overflow-visible transition-all duration-200",
          "after:pointer-events-none after:absolute after:inset-[-1px] after:rounded-[inherit] after:border after:border-blue-300/75 after:opacity-0 after:transition-opacity after:duration-200 focus-within:after:opacity-100 dark:after:border-blue-400/55",
          isHero
            ? "max-w-[44rem] rounded-[22px] border border-black/[0.035] bg-card shadow-[0_20px_55px_rgba(15,23,42,0.08)] dark:border-white/[0.06] dark:shadow-[0_24px_55px_rgba(0,0,0,0.34)]"
            : "max-w-[40rem] rounded-[18px] border border-black/[0.035] bg-card shadow-[0_12px_30px_rgba(15,23,42,0.07)] dark:border-white/[0.06] dark:shadow-[0_16px_34px_rgba(0,0,0,0.28)]",
          "focus-within:border-blue-300/75 dark:focus-within:border-blue-400/55",
          disabled && "opacity-60",
          isDragging && "ring-2 ring-primary/40 motion-reduce:ring-0 motion-reduce:border-primary",
          goalState?.active &&
            "goal-shell-glow ring-1 ring-sky-400/35 motion-reduce:ring-sky-400/25 dark:ring-sky-400/45",
        )}
      >
        {images.length > 0 ? (
          <div
            className="flex flex-wrap gap-2 px-3 pt-3"
            aria-label={t("thread.composer.attachImage")}
          >
            {images.map((img) => (
              <AttachmentChip
                key={img.id}
                image={img}
                labelRemove={t("thread.composer.remove")}
                labelEncoding={t("thread.composer.encoding")}
                normalizedHint={(orig, current) =>
                  t("thread.composer.normalizedSizeHint", {
                    orig: formatBytes(orig),
                    current: formatBytes(current),
                  })
                }
                formatError={formatRejection}
                onRemove={() => removeChip(img.id)}
                onKeyDown={onChipKey(img.id)}
                registerRef={(el) => {
                  if (el) chipRefs.current.set(img.id, el);
                  else chipRefs.current.delete(img.id);
                }}
              />
            ))}
          </div>
        ) : null}
        {runStartedAt != null || goalState?.active ? (
          <RunElapsedStrip startedAt={runStartedAt} goalState={goalState} />
        ) : null}
        {selectedAgent ? (
          <div
            className={cn(
              "flex items-center gap-2 px-3",
              images.length > 0 || runStartedAt != null || goalState?.active
                ? "pt-2"
                : isHero
                  ? "pt-3"
                  : "pt-2.5",
            )}
          >
            <AgentSelectionChip
              description={selectedAgent.description}
              onClear={handleClearAgent}
              clearLabel={t("agents.clear")}
              usingLabel={t("agents.usingAgent", { name: selectedAgent.name })}
            />
          </div>
        ) : null}
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSlashMenuDismissed(false);
            }}
            onInput={onInput}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={resolvedPlaceholder}
            disabled={disabled}
            aria-label={t("thread.composer.inputAria")}
            className={cn(
              inputTextClasses,
              "relative z-10 caret-foreground placeholder:text-muted-foreground/70",
              "focus:outline-none focus-visible:outline-none",
              "disabled:cursor-not-allowed",
            )}
          />
          <TooltipProvider delayDuration={200} skipDelayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  aria-label={expanded ? t("thread.composer.collapseInput") : t("thread.composer.expandInput")}
                  className={cn(
                    "absolute right-2 top-2 z-20 grid h-7 w-7 place-items-center rounded-full",
                    "text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {expanded ? (
                    <Minimize2 className="h-4 w-4" aria-hidden />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="left"
                align="center"
                sideOffset={8}
                collisionPadding={12}
                className={cn(
                  "rounded-[10px] border-border/60 bg-popover/95 px-2.5 py-1.5",
                  "text-[11.5px] leading-snug text-popover-foreground shadow-md backdrop-blur",
                )}
              >
                {expanded ? t("thread.composer.collapseInputHint") : t("thread.composer.expandInputHint")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {inlineError ? (
          <div
            role="alert"
            className={cn(
              "mx-3 mb-1 rounded-md border border-destructive/40 bg-destructive/8 px-2.5 py-1",
              "text-[11.5px] font-medium text-destructive",
            )}
          >
            {inlineError}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center justify-between",
            isHero ? cn("gap-1.5 px-4", showProjectPicker ? "pb-1.5" : "pb-3.5") : "gap-2 px-3 pb-2",
          )}
        >
          <div className={cn("flex min-w-0 flex-1 items-center", isHero ? "gap-1.5" : "gap-2")}>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              multiple
              hidden
              onChange={onFilePick}
            />
            <TooltipProvider delayDuration={200} skipDelayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={attachButtonDisabled}
                    aria-label={t("thread.composer.attachImage")}
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      "rounded-full text-muted-foreground hover:text-foreground",
                      isHero
                        ? "h-8 w-8 border border-border/55 bg-card shadow-[0_2px_8px_rgba(15,23,42,0.05)] hover:bg-card"
                        : "h-9 w-9 border border-border/55 bg-card shadow-[0_2px_8px_rgba(15,23,42,0.05)] hover:bg-card",
                    )}
                  >
                    <Plus className={cn(isHero ? "h-[18px] w-[18px]" : "h-4 w-4")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="center"
                  sideOffset={8}
                  collisionPadding={12}
                  className={cn(
                    "max-w-[min(22rem,calc(100vw-2rem))] rounded-[10px]",
                    "border-border/60 bg-popover/95 px-2.5 py-1.5",
                    "text-[11.5px] leading-snug text-popover-foreground",
                    "shadow-md backdrop-blur",
                  )}
                >
                  <ul className="flex flex-col gap-1">
                    {[
                      t("thread.composer.attachTooltipLimit", { max: MAX_IMAGES_PER_MESSAGE }),
                      t("thread.composer.attachTooltipImages"),
                      t("thread.composer.attachTooltipDocs"),
                    ].map((line) => (
                      <li key={line} className="flex items-start gap-1.5">
                        <span
                          className="mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-current opacity-50"
                          aria-hidden
                        />
                        <span className="min-w-0 break-words">{line}</span>
                      </li>
                    ))}
                  </ul>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {showAgentSelector ? (
              <AgentSelectorButton
                agents={agents}
                selectedAgentId={selectedAgentId}
                disabled={disabled}
                isHero={isHero}
                onSelect={handleSelectAgent}
                ariaLabel={t("agents.title")}
                emptyLabel={t("agents.empty")}
                clearLabel={t("agents.clear")}
              />
            ) : null}
            {workspaceScope ? (
              <WorkspaceAccessMenu
                scope={workspaceScope}
                disabled={disabled || workspaceScopeDisabled}
                canUseFullAccess={workspaceControls?.can_use_full_access !== false}
                isHero={isHero}
                onChange={onWorkspaceScopeChange}
              />
            ) : null}
          </div>
          <div className={cn("flex shrink-0 items-center", isHero ? "gap-1.5" : "gap-2")}>
            {modelLabel ? (
              <ComposerModelBadge
                label={modelLabel}
                provider={modelProvider}
                providerLabel={modelProviderLabel}
                isHero={isHero}
              />
            ) : null}
            <ContextChip
              messageCount={messageCount}
              contextWindowTokens={contextWindowTokens}
              contextUsage={contextUsage}
              isHero={isHero}
              hasInput={value.trim().length > 0}
            />
            <TooltipProvider delayDuration={200} skipDelayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      type={showStopButton ? "button" : "submit"}
                      size="icon"
                      disabled={showStopButton ? disabled : !canSend}
                      aria-label={showStopButton ? t("thread.composer.stop") : t("thread.composer.send")}
                      onClick={showStopButton ? onStop : undefined}
                      className={cn(
                        "rounded-full transition-transform",
                        showStopButton
                          ? "border border-border/70 bg-card text-foreground/85 shadow-[0_3px_10px_rgba(15,23,42,0.08)] hover:bg-muted/65 hover:text-foreground disabled:text-muted-foreground/50"
                          : isHero
                            ? "border border-foreground bg-foreground text-background shadow-[0_4px_12px_rgba(15,23,42,0.20)] hover:bg-foreground/90 disabled:border-foreground/35 disabled:bg-foreground/35 disabled:text-background/80"
                            : "border border-foreground bg-foreground text-background shadow-[0_3px_10px_rgba(15,23,42,0.18)] hover:bg-foreground/90 disabled:border-foreground/35 disabled:bg-foreground/35 disabled:text-background/80",
                        isHero ? "h-8 w-8" : "h-9 w-9",
                        (canSend || showStopButton) && "hover:scale-[1.03] active:scale-95",
                      )}
                    >
                      {showStopButton ? (
                        <Square className={cn("fill-current stroke-current", isHero ? "h-3 w-3" : "h-3.5 w-3.5")} />
                      ) : isStreaming ? (
                        <Loader2 className={cn(isHero ? "h-4 w-4" : "h-4 w-4", "animate-spin")} />
                      ) : (
                        <ArrowUp className={cn(isHero ? "h-4 w-4" : "h-4 w-4")} />
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="center"
                  sideOffset={8}
                  collisionPadding={12}
                  className={cn(
                    "max-w-[min(22rem,calc(100vw-2rem))] rounded-[10px]",
                    "border-border/60 bg-popover/95 px-2.5 py-1.5",
                    "text-[11.5px] leading-snug text-popover-foreground",
                    "shadow-md backdrop-blur",
                  )}
                >
                  {showStopButton ? (
                    <span>{t("thread.composer.stop")}</span>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {(expanded
                        ? [
                            t("thread.composer.sendHintNewlineExpanded"),
                            t("thread.composer.sendHintSubmitExpanded"),
                          ]
                        : [
                            t("thread.composer.sendHintEnter"),
                            t("thread.composer.sendHintNewline"),
                          ]
                      ).map((line) => (
                        <li key={line} className="flex items-start gap-1.5">
                          <span
                            className="mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-current opacity-50"
                            aria-hidden
                          />
                          <span className="min-w-0 break-words">{line}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
        <WorkspaceProjectPicker
          isHero={isHero}
          disabled={disabled || workspaceScopeDisabled}
          scope={workspaceScope}
          defaultScope={workspaceDefaultScope}
          controls={workspaceControls}
          error={workspaceError}
          onChange={onWorkspaceScopeChange}
        />
      </div>
    </form>
  );
}

function ComposerModelBadge({
  label,
  provider,
  providerLabel,
  isHero,
}: {
  label: string;
  provider?: string | null;
  providerLabel?: string | null;
  isHero: boolean;
}) {
  const inferredProvider = provider || inferProviderFromModelName(label);
  const brand = providerBrand(inferredProvider);
  const [logoIndex, setLogoIndex] = useState(0);
  const logoUrl = brand?.logoUrls[logoIndex];
  const showLogo = !!logoUrl;
  const title = providerLabel ? `${label} · ${providerLabel}` : label;

  useEffect(() => setLogoIndex(0), [inferredProvider]);

  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center rounded-full border border-border/55 bg-card font-medium text-foreground/82",
        "shadow-[0_2px_8px_rgba(15,23,42,0.045)]",
        isHero ? "h-8 max-w-[12.5rem] gap-1.5 px-2 text-[11.5px]" : "h-9 max-w-[12rem] gap-2 px-2.5 text-[12px]",
      )}
    >
      <span
        data-testid={inferredProvider ? `composer-model-logo-${inferredProvider}` : "composer-model-logo"}
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-full border bg-background",
          isHero ? "h-[18px] w-[18px]" : "h-5 w-5",
        )}
        style={{
          borderColor: brand ? `${brand.color}28` : undefined,
          boxShadow: brand ? `inset 0 0 0 1px ${brand.color}18` : undefined,
        }}
        aria-hidden
      >
        {showLogo ? (
          <img
            src={logoUrl}
            alt=""
            className={cn("object-contain", isHero ? "h-3 w-3" : "h-3.5 w-3.5")}
            onError={() => setLogoIndex((index) => index + 1)}
          />
        ) : brand ? (
          <span
            className={cn(
              "grid h-full w-full place-items-center rounded-full text-white",
              isHero ? "text-[7.5px]" : "text-[8px]",
            )}
            style={{ backgroundColor: brand.color }}
          >
            {brand.initials.slice(0, 2)}
          </span>
        ) : (
          <Sparkles className={cn("text-muted-foreground/65", isHero ? "h-3 w-3" : "h-3 w-3")} />
        )}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

interface ContextChipProps {
  messageCount: number;
  contextWindowTokens?: number | null;
  contextUsage?: ContextUsagePayload | null;
  isHero: boolean;
  hasInput?: boolean;
}

/** 上下文使用率对应的颜色档位。整体采用中性灰色,与 UI 主色调一致。 */
function contextTone(ratio: number): {
  bar: string;
  text: string;
  track: string;
} {
  if (ratio >= 0.85) {
    return {
      bar: "bg-red-500 dark:bg-red-400",
      text: "text-red-600 dark:text-red-400",
      track: "bg-red-500/15",
    };
  }
  if (ratio >= 0.6) {
    return {
      bar: "bg-amber-500 dark:bg-amber-400",
      text: "text-amber-600 dark:text-amber-400",
      track: "bg-amber-500/15",
    };
  }
  return {
    bar: "bg-foreground/55 dark:bg-foreground/55",
    text: "text-foreground/70 dark:text-foreground/70",
    track: "bg-foreground/10",
  };
}

function ContextChip({
  messageCount,
  contextWindowTokens,
  contextUsage,
  isHero,
  hasInput = false,
}: ContextChipProps) {
  const { t } = useTranslation();
  // 确保 contextWindow 总有值,让进度条始终显示。settings 未加载时用 64K 默认值。
  const DEFAULT_CONTEXT_WINDOW = 65536;
  const effectiveContextWindow = typeof contextWindowTokens === "number" && contextWindowTokens > 0
    ? contextWindowTokens
    : DEFAULT_CONTEXT_WINDOW;

  // prompt_tokens 近似当前上下文窗口的占用(最后一次 LLM 调用发送的全部历史)。
  const realUsedTokens = contextUsage?.prompt_tokens ?? 0;
  const hasRealUsage = realUsedTokens > 0;
  // 没有真实 usage 时,基于消息条数粗略估算(每条约 800 tokens)。
  const EST_TOKENS_PER_MSG = 800;
  const usedTokens = hasRealUsage
    ? realUsedTokens
    : messageCount * EST_TOKENS_PER_MSG;

  const ratio = Math.min(1, usedTokens / effectiveContextWindow);
  const tone = contextTone(ratio);
  const pct = Math.round(ratio * 100);
  const isActive = messageCount > 0 || hasRealUsage;

  // 主页(hero)且未输入文字且无消息时:只显示上下文窗口大小的数字,不显示进度条。
  // 其他情况(已输入文字、已有消息、流式响应中):显示进度条 + 百分比。
  const showProgressBar = !isHero || hasInput || isActive;

  // 悬停 tooltip。
  const tooltip = hasRealUsage
    ? t("thread.composer.contextChip.tooltipUsage", {
        prompt: realUsedTokens.toLocaleString(),
        completion: (contextUsage?.completion_tokens ?? 0).toLocaleString(),
        total: (contextUsage?.total_tokens ?? 0).toLocaleString(),
        cached: (contextUsage?.cached_tokens ?? 0).toLocaleString(),
        ctx: effectiveContextWindow.toLocaleString(),
        pct,
      })
    : t("thread.composer.contextChip.tooltipCtxOnly", {
        count: messageCount,
        tokens: effectiveContextWindow.toLocaleString(),
      });

  const barWidth = isHero ? 56 : 48;

  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border font-medium",
        "transition-colors",
        isHero ? "h-8 px-2 text-[11px]" : "h-9 px-2.5 text-[11.5px]",
        isActive
          ? "border-border/55 bg-card text-foreground/80"
          : "border-border/40 bg-card/60 text-muted-foreground/65",
      )}
    >
      {showProgressBar ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "relative h-1.5 shrink-0 overflow-hidden rounded-full",
              tone.track,
            )}
            style={{ width: `${barWidth}px` }}
            aria-hidden
          >
            <span
              className={cn("absolute inset-y-0 left-0 rounded-full transition-all", tone.bar)}
              style={{ width: `${Math.max(3, pct)}%` }}
            />
          </span>
          <span className={cn("shrink-0 tabular-nums", tone.text)}>
            {pct}%
          </span>
        </span>
      ) : (
        <span className="shrink-0 tabular-nums text-foreground/55">
          {(effectiveContextWindow / 1024).toFixed(0)}K
        </span>
      )}
    </span>
  );
}

interface SlashCommandPaletteProps {
  commands: SlashPaletteCommand[];
  selectedIndex: number;
  layout: SlashPaletteLayout;
  isHero: boolean;
  onHover: (index: number) => void;
  onChoose: (command: SlashPaletteCommand) => void;
}

function useSelectedOptionScroll(selectedIndex: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const option = container.querySelector<HTMLElement>(
      `[data-palette-index="${selectedIndex}"]`,
    );
    if (typeof option?.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  return containerRef;
}

function SlashCommandPalette({
  commands,
  selectedIndex,
  layout,
  isHero,
  onHover,
  onChoose,
}: SlashCommandPaletteProps) {
  const { t } = useTranslation();
  const listMaxHeight = Math.max(
    0,
    layout.maxHeight - SLASH_PALETTE_CHROME_PX,
  );
  const listRef = useSelectedOptionScroll(selectedIndex);
  return (
    <div
      role="listbox"
      aria-label={t("thread.composer.slash.ariaLabel")}
      style={{ maxHeight: layout.maxHeight }}
      className={cn(
        "absolute left-1/2 z-30 w-[calc(100%-0.5rem)] -translate-x-1/2 overflow-hidden rounded-[18px] border",
        layout.placement === "above" ? "bottom-full mb-2" : "top-full mt-2",
        "border-border/65 bg-popover p-1.5 text-popover-foreground shadow-[0_18px_55px_rgba(15,23,42,0.16)]",
        "dark:border-white/10 dark:shadow-[0_22px_55px_rgba(0,0,0,0.45)]",
        isHero ? "max-w-[44rem]" : "max-w-[40rem]",
      )}
    >
      <div ref={listRef} className="overflow-y-auto pr-0.5" style={{ maxHeight: listMaxHeight }}>
        {commands.map((command, index) => {
          const Icon = COMMAND_ICONS[command.icon] ?? CircleHelp;
          const selected = index === selectedIndex;
          const commandKey = slashCommandI18nKey(command.command);
          const title = t(`thread.composer.slash.commands.${commandKey}.title`, {
            defaultValue: command.title,
          });
          const description = t(`thread.composer.slash.commands.${commandKey}.description`, {
            defaultValue: command.description,
          });
          return (
            <button
              key={command.command}
              type="button"
              role="option"
              data-palette-index={index}
              aria-selected={selected}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onChoose(command);
              }}
              className={cn(
                "flex min-h-[44px] w-full items-center gap-3 rounded-[13px] px-3 py-2 text-left transition-colors",
                selected
                  ? "bg-foreground/[0.065] text-foreground dark:bg-white/[0.09]"
                  : "text-foreground/86 hover:bg-foreground/[0.045] dark:hover:bg-white/[0.065]",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors",
                  selected && "text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="min-w-0 truncate text-[13.5px] font-semibold tracking-normal text-foreground">
                  {title}
                </span>
                <span className="min-w-0 truncate text-[13px] text-muted-foreground">
                  {command.detail || description}
                </span>
              </span>
              <span className="ml-2 flex shrink-0 items-center gap-1.5">
                {command.badge || command.recent ? (
                  <span className="hidden rounded-full bg-foreground/[0.055] px-2 py-1 text-[11px] font-medium text-muted-foreground sm:inline-flex">
                    {command.badge ?? t("thread.composer.slash.badges.recent")}
                  </span>
                ) : null}
                <span className="font-mono text-[12px] text-muted-foreground/60">
                  {command.argHint ? `${command.command} ${command.argHint}` : command.command}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface AttachmentChipProps {
  image: AttachedImage;
  labelRemove: string;
  labelEncoding: string;
  normalizedHint: (origBytes: number, currentBytes: number) => string;
  formatError: (reason: AttachmentError) => string;
  onRemove: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}

function AttachmentChip({
  image,
  labelRemove,
  labelEncoding,
  normalizedHint,
  formatError,
  onRemove,
  onKeyDown,
  registerRef,
}: AttachmentChipProps) {
  const sizeLabel =
    image.status === "ready" && image.normalized && image.encodedBytes
      ? normalizedHint(image.file.size, image.encodedBytes)
      : formatBytes(image.file.size);
  const tone =
    image.status === "error"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : "border-border/70 bg-muted/60";

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 rounded-[12px] border px-2 py-1.5",
        "transition-colors motion-reduce:transition-none",
        tone,
      )}
      data-testid="composer-chip"
    >
      <div className="relative h-10 w-10 overflow-hidden rounded-md bg-background">
        {image.isDocument ? (
          <div className="flex h-full w-full items-center justify-center">
            <FileText className="h-5 w-5 text-muted-foreground" aria-hidden />
          </div>
        ) : image.previewUrl ? (
          <img
            src={image.previewUrl}
            alt=""
            aria-hidden
            loading="eager"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
          </div>
        )}
        {image.status === "encoding" ? (
          <div
            className="absolute inset-0 flex items-center justify-center bg-background/60"
            aria-label={labelEncoding}
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col text-[11.5px] leading-4">
        <span className="truncate max-w-[14rem] font-medium" title={image.file.name}>
          {image.file.name}
        </span>
        <span className="truncate text-muted-foreground">
          {image.status === "error" && image.error
            ? formatError(image.error)
            : sizeLabel}
        </span>
      </div>
      <button
        type="button"
        ref={registerRef}
        onClick={onRemove}
        onKeyDown={onKeyDown}
        aria-label={labelRemove}
        className={cn(
          "ml-1 grid h-5 w-5 flex-none place-items-center rounded-full",
          "text-muted-foreground/80 hover:bg-foreground/8 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
        )}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

/* ─── Subagent Selector ─────────────────────────────────── */

interface AgentSelectorButtonProps {
  agents: AgentInfo[];
  selectedAgentId: string | null;
  disabled?: boolean;
  isHero: boolean;
  onSelect: (agentId: string) => void;
  ariaLabel: string;
  emptyLabel: string;
  clearLabel: string;
}

function AgentSelectorButton({
  agents,
  selectedAgentId,
  disabled,
  isHero,
  onSelect,
  ariaLabel,
  emptyLabel,
  clearLabel,
}: AgentSelectorButtonProps) {
  const active = !!selectedAgentId;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={disabled}
          aria-label={ariaLabel}
          title={ariaLabel}
          className={cn(
            "rounded-full transition-colors",
            isHero
              ? "h-8 w-8 border border-border/55 bg-card shadow-[0_2px_8px_rgba(15,23,42,0.05)] hover:bg-card"
              : "h-9 w-9 border border-border/55 bg-card shadow-[0_2px_8px_rgba(15,23,42,0.05)] hover:bg-card",
            active
              ? "text-sky-600 hover:text-sky-600 dark:text-sky-400"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Users className={cn(isHero ? "h-[18px] w-[18px]" : "h-4 w-4")} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[20rem] max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {ariaLabel}
        </DropdownMenuLabel>
        {agents.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          agents.map((agent) => {
            const selected = agent.name === selectedAgentId;
            return (
              <DropdownMenuItem
                key={agent.name}
                onSelect={() => onSelect(agent.name)}
                className={cn(
                  "flex flex-col items-start gap-0.5 py-2",
                  selected && "bg-foreground/[0.055] dark:bg-white/[0.08]",
                )}
              >
                <span className="flex w-full items-center gap-1.5 text-[13px] font-medium text-foreground">
                  <Users className="h-3.5 w-3.5 shrink-0 text-sky-500" aria-hidden />
                  <span className="truncate">{agent.name}</span>
                  {selected ? (
                    <span className="ml-auto shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                      ●
                    </span>
                  ) : null}
                </span>
                {agent.description ? (
                  <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground/80">
                    {agent.description}
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        {selectedAgentId ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onSelect("__none__")}
              className="text-[12px] text-muted-foreground"
            >
              <X className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {clearLabel}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AgentSelectionChipProps {
  description?: string;
  onClear: () => void;
  clearLabel: string;
  usingLabel: string;
}

function AgentSelectionChip({
  description,
  onClear,
  clearLabel,
  usingLabel,
}: AgentSelectionChipProps) {
  return (
    <span
      data-testid="composer-agent-chip"
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border border-sky-500/30",
        "bg-sky-500/10 px-2 py-1 text-[11.5px] font-medium text-sky-700 dark:text-sky-300",
      )}
      title={description || usingLabel}
    >
      <Users className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{usingLabel}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={clearLabel}
        title={clearLabel}
        className={cn(
          "ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full",
          "text-sky-700/70 transition-colors hover:bg-sky-500/20 hover:text-sky-700",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40",
          "dark:text-sky-300/70 dark:hover:bg-sky-500/25 dark:hover:text-sky-300",
        )}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </span>
  );
}
