import { useLayoutEffect, useRef } from "react";

import {
  Activity,
  BookOpen,
  Brain,
  CircleHelp,
  History,
  RotateCw,
  Shield,
  Sparkles,
  Square,
  SquarePen,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import type { SlashPaletteCommand, SlashPaletteLayout } from "../types";

// ─── 斜杠命令面板布局常量(主组件在定位计算时也会用到) ─────────
/** 面板与输入框之间的间距(px)。 */
export const SLASH_PALETTE_GAP_PX = 8;
/** 面板最大高度(px)。 */
export const SLASH_PALETTE_MAX_HEIGHT_PX = 288;
/** 面板最小高度(px),用于判断上方空间是否足够。 */
export const SLASH_PALETTE_MIN_HEIGHT_PX = 144;
/** 面板内部 chrome(内边距等)占用的高度(px),用于列表 maxHeight 计算。 */
const SLASH_PALETTE_CHROME_PX = 12;

/** 命令名 → 图标的映射表(与后端 SlashCommand.icon 字段对齐)。 */
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

/** 把命令字符串(如 ``/book-open``)转换为 i18n key 片段(如 ``book_open``)。 */
export function slashCommandI18nKey(command: string): string {
  return command.replace(/^\//, "").replace(/-/g, "_");
}

export interface SlashCommandPaletteProps {
  commands: SlashPaletteCommand[];
  selectedIndex: number;
  layout: SlashPaletteLayout;
  isHero: boolean;
  onHover: (index: number) => void;
  onChoose: (command: SlashPaletteCommand) => void;
}

/** 让选中项自动滚动到可视区内的辅助 hook。 */
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

/** 斜杠命令选择面板,根据当前输入前缀过滤并展示匹配的命令列表。 */
export function SlashCommandPalette({
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
                <span className="text-[12px] text-muted-foreground/60">
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
