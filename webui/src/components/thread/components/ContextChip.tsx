import { useTranslation } from "react-i18next";

import type { ContextUsagePayload } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ContextChipProps {
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

/** 输入框右下角的上下文占用 chip,展示当前 token 使用率进度条 + 百分比。
 *  - 有真实 usage(从 turn_end 推送)时按 prompt_tokens 计算占比。
 *  - 无真实 usage 时按消息条数估算(每条约 800 tokens)。
 *  - hero 且无消息无输入时只展示上下文窗口大小数字。 */
export function ContextChip({
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
          {effectiveContextWindow >= 1_000_000
            ? `${(effectiveContextWindow / 1_000_000).toFixed(effectiveContextWindow % 1_000_000 === 0 ? 0 : 1)}M`
            : `${Math.round(effectiveContextWindow / 1_000)}K`}
        </span>
      )}
    </span>
  );
}
