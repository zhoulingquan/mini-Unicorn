import { useCallback, useState } from "react";

type PendingItem = { key: string; label: string };

/**
 * 管理侧边栏中"删除/重命名 chat / 重命名项目"三个对话框的待操作项状态。
 *
 * 拆分原因:
 * - 这三组 state 本身彼此同质(都是 {key,label} | null),仅被对应的"请求"
 *   回调写入,与 Shell 中的业务逻辑(deleting fallback、updateSidebarState)解耦。
 * - 把它们集中到一个 hook 后,Shell 中不再需要散落的 useState 与 request 回调。
 *
 * 确认/取消逻辑仍保留在 Shell 中,因为:
 * - onConfirmDelete 需要 deleteChat、activeKey、sessions 来计算删除后的回退会话
 * - onConfirmRename / onConfirmProjectRename 需要调用 updateSidebarState
 *   (该 hook 来自 useSidebarState,与 sidebar 持久化强耦合)
 */
export function useDeleteRenameDialog() {
  const [pendingDelete, setPendingDelete] = useState<PendingItem | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingItem | null>(null);
  const [pendingProjectRename, setPendingProjectRename] =
    useState<PendingItem | null>(null);

  const requestDelete = useCallback((key: string, label: string) => {
    setPendingDelete({ key, label });
  }, []);

  const requestRename = useCallback((key: string, label: string) => {
    setPendingRename({ key, label });
  }, []);

  const requestProjectRename = useCallback((key: string, label: string) => {
    setPendingProjectRename({ key, label });
  }, []);

  const cancelDelete = useCallback(() => setPendingDelete(null), []);
  const cancelRename = useCallback(() => setPendingRename(null), []);
  const cancelProjectRename = useCallback(
    () => setPendingProjectRename(null),
    [],
  );

  return {
    pendingDelete,
    pendingRename,
    pendingProjectRename,
    requestDelete,
    requestRename,
    requestProjectRename,
    cancelDelete,
    cancelRename,
    cancelProjectRename,
  };
}
