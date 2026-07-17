import * as React from "react";

import { cn } from "@/lib/utils";

export interface NoticeBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/** Inline success / info banner (emerald accent). */
export function NoticeBanner({ children, className, ...props }: NoticeBannerProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface ErrorBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/** Inline error banner (destructive accent). */
export function ErrorBanner({ children, className, ...props }: ErrorBannerProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
