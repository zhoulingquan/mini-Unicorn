// 基础布局组件:SettingsRow / SettingsGroup / SettingsSectionTitle /
// SettingsStatusMessage / StatusPill / ClearableInput / OverviewRowIcon / OverviewListRow
// 从 SettingsView.tsx 拆分,供各 section 与辅助组件复用。

import type { ReactNode } from "react";
import { ChevronRight, X, type LucideIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SettingsSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
      {children}
    </h2>
  );
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
      <div className="divide-y divide-border/45">{children}</div>
    </div>
  );
}

export function SettingsRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[68px] flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        {Icon ? (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-muted text-foreground/82 transition-colors group-hover:bg-muted/80 dark:bg-muted/70">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="text-[14px] font-medium leading-5 text-foreground">{title}</div>
          {description ? (
            // 窄屏隐藏描述文字,避免被挤压成窄长条;sm 及以上显示并限制宽度。
            <div className="mt-0.5 hidden max-w-[28rem] text-[12px] leading-5 text-muted-foreground sm:block">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      {children ? <div className="shrink-0 sm:ml-6">{children}</div> : null}
    </div>
  );
}

export function SettingsStatusMessage({
  children,
  tone,
}: {
  children?: ReactNode;
  tone?: "accent" | "danger";
}) {
  if (!children) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        tone === "accent" && "font-medium text-blue-600 dark:text-blue-300",
        tone === "danger" && "font-medium text-destructive",
      )}
    >
      {tone ? (
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            tone === "accent" &&
              "bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.14)] dark:bg-blue-400 dark:shadow-[0_0_0_3px_rgba(96,165,250,0.18)]",
            tone === "danger" && "bg-destructive/70",
          )}
          aria-hidden
        />
      ) : null}
      <span>{children}</span>
    </span>
  );
}

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[260px] items-center rounded-full px-2.5 py-1 text-[12px] font-medium",
        tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/** 带一键清空的 Input 包装:有值时在右侧显示 X 按钮。
 *
 * `trailingSlot` 用于已有右侧图标(如 API Key 的眼睛按钮)的场景,
 * X 会排在 trailingSlot 之前;`clearAlign` 控制对齐方式。
 */
export function ClearableInput({
  value,
  onChange,
  onClear,
  className,
  clearClassName,
  trailingSlot,
  ...rest
}: {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  className?: string;
  clearClassName?: string;
  trailingSlot?: React.ReactNode;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const hasValue = typeof value === "string" && value.length > 0;
  const basePadding = trailingSlot ? "pr-[68px]" : "pr-9";
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={onChange}
        className={cn(basePadding, className)}
        {...rest}
      />
      {hasValue ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={onClear}
          aria-label="clear"
          className={cn(
            "absolute top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            trailingSlot ? "right-9" : "right-1.5",
            clearClassName,
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
      {trailingSlot}
    </div>
  );
}

export function OverviewRowIcon({
  icon: Icon,
}: {
  icon: LucideIcon;
}) {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-muted text-foreground/82 transition-colors group-hover:bg-muted/80 dark:bg-muted/70">
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

export function OverviewListRow({
  icon: Icon,
  title,
  value,
  caption,
  onClick,
}: {
  icon: LucideIcon;
  valueLogoProvider?: string | null;
  title: string;
  value: string;
  caption: string;
  showBrandLogos?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <OverviewRowIcon icon={Icon} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium leading-5 text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-5 text-muted-foreground">{caption}</span>
      </span>
      <span className="ml-auto flex min-w-0 max-w-[48%] items-center gap-2">
        <span className="truncate text-right text-[13px] leading-5 text-muted-foreground">
          {value}
        </span>
        {onClick ? (
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        ) : null}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className="flex min-h-[68px] w-full items-center gap-3 px-4 py-3.5 text-left sm:px-5">
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[68px] w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 sm:px-5"
    >
      {content}
    </button>
  );
}
