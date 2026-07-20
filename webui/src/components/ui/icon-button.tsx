import * as React from "react";

import { cn } from "@/lib/utils";

export function IconButton({
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
