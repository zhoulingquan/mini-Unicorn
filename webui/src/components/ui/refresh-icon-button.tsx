import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** 各 View 顶栏通用的刷新按钮：loading 时图标旋转、按钮禁用。 */
export function RefreshIconButton({
  onClick,
  loading,
  title,
}: {
  onClick: () => void;
  loading: boolean;
  title?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={onClick}
      disabled={loading}
      title={title}
      aria-label={title}
    >
      <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
    </Button>
  );
}
