import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deriveTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChatSummary } from "@/lib/types";

interface SearchDialogProps {
  /** 是否打开。 */
  open: boolean;
  /** 受控开关 — 关闭时调用。 */
  onOpenChange: (open: boolean) => void;
  /** 待搜索的会话列表(通常与 Sidebar 一致,不包含 channel 序号)。 */
  sessions: ChatSummary[];
  /** 用户自定义标题(同 SidebarState.title_overrides)。 */
  titleOverrides?: Record<string, string>;
  /** 选中某个会话时调用。 */
  onSelect: (key: string) => void;
}

/**
 * 居中的搜索弹窗。
 *
 * 契约:
 * - role="dialog" aria-label="Search"(通过 sr-only DialogTitle 提供)
 * - 内含 role="textbox" name="Search" 输入框
 * - 列出全部会话(显示 title 或 preview 派生的标签,不显示 channel 名/序号)
 * - 支持空格分隔的多词 AND 匹配(同时匹配 title/preview)
 * - 点击某项或按 Enter 选中当前过滤后的第一项后关闭
 */
export function SearchDialog({
  open,
  onOpenChange,
  sessions,
  titleOverrides = {},
  onSelect,
}: SearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fallbackTitle = t("chat.newChat");

  // 每次打开时清空查询并把焦点放到输入框。
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const items = useMemo(() => {
    return sessions.map((session) => {
      const title =
        titleOverrides[session.key]?.trim()
        || session.title?.trim()
        || deriveTitle(session.preview, fallbackTitle);
      return { key: session.key, title, preview: session.preview };
    });
  }, [sessions, titleOverrides, fallbackTitle]);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLocaleLowerCase("en");
    if (!trimmed) return items;
    // 空格分隔的多词全部命中才算匹配(AND)。
    const terms = trimmed.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;
    return items.filter((item) => {
      const haystack = `${item.title} ${item.preview ?? ""}`.toLocaleLowerCase("en");
      return terms.every((term) => haystack.includes(term));
    });
  }, [items, query]);

  const handleSelect = (key: string) => {
    onOpenChange(false);
    onSelect(key);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    const first = filtered[0];
    if (!first) return;
    event.preventDefault();
    handleSelect(first.key);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          "max-w-xl gap-0 overflow-hidden p-0",
        )}
      >
        {/* sr-only DialogTitle — Radix Dialog 通过它为 dialog 提供 accessible name "Search"。 */}
        <DialogTitle className="sr-only">{t("sidebar.search")}</DialogTitle>
        <Input
          ref={inputRef}
          type="text"
          role="textbox"
          aria-label={t("sidebar.search")}
          placeholder={t("search.placeholder", { defaultValue: t("sidebar.search") })}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          className={cn(
            "h-12 w-full rounded-none border-0 border-b border-border/60 bg-transparent px-4 text-[15px] shadow-none focus-visible:ring-0",
          )}
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t("search.empty", { defaultValue: "No matches" })}
            </div>
          ) : null}
          <ul>
            {filtered.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  onClick={() => handleSelect(item.key)}
                  className={cn(
                    "block w-full truncate px-4 py-2 text-left text-sm",
                    "hover:bg-accent/60 focus:bg-accent/60 focus:outline-none",
                  )}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
