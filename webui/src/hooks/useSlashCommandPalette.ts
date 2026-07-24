import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import type { SlashCommand } from "@/lib/types";
import { STORAGE_KEYS } from "@/lib/storage";

import type {
  SlashPaletteCommand,
  SlashPaletteLayout,
} from "@/components/thread/types";
import {
  SLASH_PALETTE_GAP_PX,
  SLASH_PALETTE_MAX_HEIGHT_PX,
  SLASH_PALETTE_MIN_HEIGHT_PX,
  slashCommandI18nKey,
} from "@/components/thread/components/SlashCommandPalette";

const SLASH_RECENTS_STORAGE_KEY = STORAGE_KEYS.slashCommandRecents;
const SLASH_RECENTS_LIMIT = 5;

/** 从 localStorage 读取最近使用的斜杠命令(用于面板排序)。 */
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

/** 把最近使用的斜杠命令写入 localStorage。 */
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

/** 计算元素在所有可滚动祖先裁剪后的可见垂直区间(top/bottom)。 */
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

export interface UseSlashCommandPaletteParams {
  /** 当前输入框文本(用于解析斜杠查询)。 */
  value: string;
  /** 输入框是否禁用(禁用时不显示面板)。 */
  disabled: boolean;
  /** 是否正在流式输出(影响 /stop 命令展示)。 */
  isStreaming: boolean;
  /** 停止回调(用于 /stop 命令)。 */
  onStop?: () => void;
  /** 全部斜杠命令列表。 */
  slashCommands: SlashCommand[];
  /** 当前模型标签(用于 /model 命令详情)。 */
  modelLabel?: string | null;
  /** 目标状态(用于 /goal 命令详情)。 */
  goalState?: { active?: boolean } | null;
  /** 表单 ref(用于面板布局计算与外部点击关闭)。 */
  formRef: RefObject<HTMLFormElement | null>;
  /** 输入框高度自适应回调(选中命令后重新调整)。 */
  resizeTextarea: () => void;
  /** 用户选中非 /stop 命令时回调,调用方据此更新输入框文本与错误状态。 */
  onCommandSelected?: (command: SlashCommand) => void;
}

export interface UseSlashCommandPaletteResult {
  /** 当前过滤后的命令列表(已排序、已附加 detail/badge)。 */
  filteredSlashCommands: SlashPaletteCommand[];
  /** 是否显示面板。 */
  showSlashMenu: boolean;
  /** 当前选中的命令索引(键盘导航)。 */
  selectedCommandIndex: number;
  setSelectedCommandIndex: (index: number | ((prev: number) => number)) => void;
  /** 面板布局(位置 + 最大高度)。 */
  slashPaletteLayout: SlashPaletteLayout;
  /** 选择一个命令(点击或键盘确认)。 */
  chooseSlashCommand: (command: SlashCommand) => void;
  /** 关闭面板(Escape 或外部点击)。 */
  dismiss: () => void;
  /** 重置面板状态(新对话或发送后)。 */
  reset: () => void;
  /** 处理键盘事件,返回 true 表示已消费(调用方不再处理)。 */
  onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/** 斜杠命令面板状态与逻辑。
 *
 * 封装命令过滤、排序、recent 持久化、面板布局计算、键盘导航,
 * 把这些与输入框核心逻辑解耦。 */
export function useSlashCommandPalette({
  value,
  disabled,
  isStreaming,
  onStop,
  slashCommands,
  modelLabel,
  goalState,
  formRef,
  resizeTextarea,
  onCommandSelected,
}: UseSlashCommandPaletteParams): UseSlashCommandPaletteResult {
  const { t } = useTranslation();
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [recentSlashCommands, setRecentSlashCommands] = useState<string[]>(() => readSlashRecents());
  const [slashPaletteLayout, setSlashPaletteLayout] = useState<SlashPaletteLayout>({
    placement: "above",
    maxHeight: SLASH_PALETTE_MAX_HEIGHT_PX,
  });

  // 解析当前斜杠查询:仅当输入以 "/" 开头且无空格时激活。
  const slashQuery = useMemo(() => {
    if (disabled || slashMenuDismissed || !value.startsWith("/")) return null;
    const commandToken = value.slice(1);
    if (/\s/.test(commandToken)) return null;
    return commandToken.toLowerCase();
  }, [disabled, slashMenuDismissed, value]);

  // 构建可见命令列表(含 /stop 注入)。
  const visibleSlashCommands = useMemo(() => {
    const baseCommands = slashCommands.filter((command) => command.command !== "/stop");
    if (!(isStreaming && onStop)) return baseCommands;
    const stopCommand = slashCommands.find((command) => command.command === "/stop") ?? {
      command: "/stop",
      title: "Stop current task",
      description: "Cancel the active agent turn for this chat.",
      icon: "square",
    };
    return [stopCommand, ...baseCommands];
  }, [isStreaming, onStop, slashCommands]);

  // 过滤、排序、附加详情。
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

    return withDetails.slice(0, 8);
  }, [goalState?.active, isStreaming, modelLabel, recentSlashCommands, slashQuery, t, visibleSlashCommands]);

  const showSlashMenu = filteredSlashCommands.length > 0;

  // 切换查询时重置选中索引。
  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [slashQuery]);

  // 选中索引越界时回零。
  useEffect(() => {
    if (selectedCommandIndex >= filteredSlashCommands.length) {
      setSelectedCommandIndex(0);
    }
  }, [filteredSlashCommands.length, selectedCommandIndex]);

  // 外部点击关闭面板。
  useEffect(() => {
    if (!showSlashMenu) return;

    const dismissOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && formRef.current?.contains(target)) return;
      setSlashMenuDismissed(true);
    };

    document.addEventListener("pointerdown", dismissOnPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOnPointerDown, true);
    };
  }, [showSlashMenu, formRef]);

  // 面板布局计算(上方/下方 + 最大高度)。
  useLayoutEffect(() => {
    if (!showSlashMenu) return;

    const updateLayout = () => {
      const form = formRef.current;
      if (!form) return;
      const rect = form.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const bounds = getVisibleBounds(form);
      const spaceAbove = Math.max(0, rect.top - bounds.top - SLASH_PALETTE_GAP_PX);
      const spaceBelow = Math.max(0, bounds.bottom - rect.bottom - SLASH_PALETTE_GAP_PX);
      const placement = spaceAbove >= SLASH_PALETTE_MIN_HEIGHT_PX || spaceAbove >= spaceBelow
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
  }, [filteredSlashCommands.length, showSlashMenu, formRef]);

  const chooseSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (command.command === "/stop" && isStreaming && onStop) {
        onStop();
        setSlashMenuDismissed(true);
        // /stop 不计入 recent,但需要清空输入框。
        onCommandSelected?.(command);
        resizeTextarea();
        return;
      }

      const nextRecents = [
        command.command,
        ...recentSlashCommands.filter((item) => item !== command.command),
      ].slice(0, SLASH_RECENTS_LIMIT);
      setRecentSlashCommands(nextRecents);
      storeSlashRecents(nextRecents);

      setSlashMenuDismissed(true);
      onCommandSelected?.(command);
      resizeTextarea();
    },
    [isStreaming, onStop, onCommandSelected, recentSlashCommands, resizeTextarea],
  );

  const dismiss = useCallback(() => {
    setSlashMenuDismissed(true);
  }, []);

  const reset = useCallback(() => {
    setSlashMenuDismissed(false);
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showSlashMenu) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedCommandIndex((idx) => (idx + 1) % filteredSlashCommands.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedCommandIndex(
          (idx) => (idx - 1 + filteredSlashCommands.length) % filteredSlashCommands.length,
        );
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        chooseSlashCommand(filteredSlashCommands[selectedCommandIndex]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuDismissed(true);
        return true;
      }
      return false;
    },
    [chooseSlashCommand, filteredSlashCommands, selectedCommandIndex, showSlashMenu],
  );

  return {
    filteredSlashCommands,
    showSlashMenu,
    selectedCommandIndex,
    setSelectedCommandIndex,
    slashPaletteLayout,
    chooseSlashCommand,
    dismiss,
    reset,
    onKeyDown,
  };
}
