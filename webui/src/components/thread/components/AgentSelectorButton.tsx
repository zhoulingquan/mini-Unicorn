import { Users, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface AgentSelectorButtonProps {
  agents: AgentInfo[];
  selectedAgentId: string | null;
  disabled?: boolean;
  isHero: boolean;
  onSelect: (agentId: string) => void;
  ariaLabel: string;
  emptyLabel: string;
  clearLabel: string;
}

/** 输入框左下角的 subagent 选择按钮(Users 图标),点击展开下拉菜单。
 *  - 选择 agent 时调用 ``onSelect(agent.name)``。
 *  - 清除时调用 ``onSelect("__none__")``,由主组件转译为 ``onClearAgent``。 */
export function AgentSelectorButton({
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
          <Users className="h-4 w-4" />
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
