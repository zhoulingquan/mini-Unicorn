import * as React from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ViewShellProps {
  onBack: () => void;
  icon: React.ReactNode;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
}

/** 各资源页（Skills/Tools/Mcp/Cron/Agents/Channels）通用的页面骨架：
 * 左上返回按钮 + 图标 + 标题 + 右侧操作区 + 可滚动主体。 */
export function ViewShell({
  onBack,
  icon,
  title,
  actions,
  children,
  bodyClassName,
}: ViewShellProps) {
  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ChevronRight className="h-4 w-4 rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          {icon}
          <h1 className="text-sm font-semibold">{title}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      <div className={cn("flex-1 overflow-y-auto px-4 py-3", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
