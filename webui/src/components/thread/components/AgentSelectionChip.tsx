import { Users, X } from "lucide-react";

import { cn } from "@/lib/utils";

export interface AgentSelectionChipProps {
  description?: string;
  onClear: () => void;
  clearLabel: string;
  usingLabel: string;
}

/** 输入框上方展示当前已选 subagent 的 chip,带清除按钮。 */
export function AgentSelectionChip({
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
