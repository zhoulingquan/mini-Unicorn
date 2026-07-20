import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/** 标准 loading spinner，默认 mr-2 h-4 w-4 animate-spin。 */
export function LoadingSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn("mr-2 h-4 w-4 animate-spin", className)} />;
}
