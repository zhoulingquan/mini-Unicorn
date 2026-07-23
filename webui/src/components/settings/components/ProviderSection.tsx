// Provider 分组容器:ProvidersSettings 中"已配置/未配置"两块区域复用。
// 从 SettingsView.tsx 拆分而来。

import type { ReactNode } from "react";

export function ProviderSection({
  title,
  count,
  empty,
  showCount = false,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  /** 是否在标题右侧显示数量 badge(仅已配置区域开启)。 */
  showCount?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <ByokSectionHeader title={title} count={showCount ? count : undefined} />
      <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.07)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.22)]">
        {count > 0 ? (
          <div className="divide-y divide-border/45">{children}</div>
        ) : (
          <ByokEmptyState>{empty}</ByokEmptyState>
        )}
      </div>
    </section>
  );
}

export function ByokSectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
        {title}
      </h2>
      {count != null ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">
          {count}
        </span>
      ) : null}
    </div>
  );
}

export function ByokEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[18px] border border-dashed border-border/65 bg-card/45 px-4 py-5 text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}
