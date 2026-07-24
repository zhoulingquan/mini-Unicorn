import { useCallback } from "react";

import type { ChatSummary, SidebarStatePayload } from "@/lib/types";

interface PendingItem {
  key: string;
  label: string;
}

export interface UseSidebarActionsParams {
  sidebarState: SidebarStatePayload;
  updateSidebarState: (
    updater: (current: SidebarStatePayload) => SidebarStatePayload,
  ) => Promise<void>;
  activeKey: string | null;
  sessions: ChatSummary[];
  setActiveKey: (key: string | null) => void;
  pendingRename: PendingItem | null;
  pendingProjectRename: PendingItem | null;
  cancelRename: () => void;
  cancelProjectRename: () => void;
}

export interface UseSidebarActionsResult {
  onTogglePin: (key: string) => void;
  onConfirmRename: (title: string) => void;
  onToggleGroup: (groupId: string) => void;
  onConfirmProjectRename: (title: string) => void;
  onToggleArchive: (key: string) => void;
  onToggleArchived: () => void;
}

/** 侧边栏操作回调集合:置顶/重命名/分组折叠/项目重命名/归档/显示归档。
 *
 * 这些回调全部依赖 ``updateSidebarState`` 做不可变更新,模式一致,
 * 从 Shell 中抽出以降低顶层组件复杂度。 */
export function useSidebarActions({
  sidebarState,
  updateSidebarState,
  activeKey,
  sessions,
  setActiveKey,
  pendingRename,
  pendingProjectRename,
  cancelRename,
  cancelProjectRename,
}: UseSidebarActionsParams): UseSidebarActionsResult {
  const onTogglePin = useCallback(
    (key: string) => {
      void updateSidebarState((current) => {
        const pinned = new Set(current.pinned_keys);
        if (pinned.has(key)) {
          pinned.delete(key);
        } else {
          pinned.add(key);
        }
        return {
          ...current,
          pinned_keys: Array.from(pinned),
        };
      });
    },
    [updateSidebarState],
  );

  const onConfirmRename = useCallback(
    (title: string) => {
      if (!pendingRename) return;
      const key = pendingRename.key;
      cancelRename();
      void updateSidebarState((current) => {
        const titleOverrides = { ...current.title_overrides };
        const cleaned = title.trim();
        if (cleaned) {
          titleOverrides[key] = cleaned;
        } else {
          delete titleOverrides[key];
        }
        return {
          ...current,
          title_overrides: titleOverrides,
        };
      });
    },
    [cancelRename, pendingRename, updateSidebarState],
  );

  const onToggleGroup = useCallback(
    (groupId: string) => {
      void updateSidebarState((current) => {
        const collapsedGroups = { ...current.collapsed_groups };
        if (groupId === "workspace:chats" || groupId === "date:all") {
          if (collapsedGroups[groupId] === false) {
            delete collapsedGroups[groupId];
          } else {
            collapsedGroups[groupId] = false;
          }
          return {
            ...current,
            collapsed_groups: collapsedGroups,
          };
        }
        if (collapsedGroups[groupId]) {
          delete collapsedGroups[groupId];
        } else {
          collapsedGroups[groupId] = true;
        }
        return {
          ...current,
          collapsed_groups: collapsedGroups,
        };
      });
    },
    [updateSidebarState],
  );

  const onConfirmProjectRename = useCallback(
    (title: string) => {
      if (!pendingProjectRename) return;
      const key = pendingProjectRename.key;
      cancelProjectRename();
      void updateSidebarState((current) => {
        const projectNameOverrides = { ...current.project_name_overrides };
        const cleaned = title.trim();
        if (cleaned) {
          projectNameOverrides[key] = cleaned;
        } else {
          delete projectNameOverrides[key];
        }
        return {
          ...current,
          project_name_overrides: projectNameOverrides,
        };
      });
    },
    [cancelProjectRename, pendingProjectRename, updateSidebarState],
  );

  const onToggleArchive = useCallback(
    (key: string) => {
      void updateSidebarState((current) => {
        const archived = new Set(current.archived_keys);
        const pinned = current.pinned_keys.filter((item) => item !== key);
        if (archived.has(key)) {
          archived.delete(key);
        } else {
          archived.add(key);
        }
        return {
          ...current,
          pinned_keys: pinned,
          archived_keys: Array.from(archived),
        };
      });
      if (activeKey === key && !sidebarState.archived_keys.includes(key)) {
        const archived = new Set([...sidebarState.archived_keys, key]);
        const next = sessions.find((session) => !archived.has(session.key));
        setActiveKey(next?.key ?? null);
      }
    },
    [activeKey, sessions, sidebarState.archived_keys, updateSidebarState, setActiveKey],
  );

  const onToggleArchived = useCallback(() => {
    void updateSidebarState((current) => ({
      ...current,
      view: {
        ...current.view,
        show_archived: !current.view.show_archived,
      },
    }));
  }, [updateSidebarState]);

  return {
    onTogglePin,
    onConfirmRename,
    onToggleGroup,
    onConfirmProjectRename,
    onToggleArchive,
    onToggleArchived,
  };
}
