import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ResourceDeleteConfirmDialogProps {
  open: boolean;
  resourceName: string;
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
  cancelKey: string;
  confirmKey: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Skills / Agents 等资源页通用的删除确认弹窗。
 * titleKey 会以 `{ name: resourceName }` 插值；其余 key 直接翻译。 */
export function ResourceDeleteConfirmDialog({
  open,
  resourceName,
  icon: Icon,
  titleKey,
  descriptionKey,
  cancelKey,
  confirmKey,
  onCancel,
  onConfirm,
}: ResourceDeleteConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <AlertDialogContent
        className="w-[min(calc(100vw-2rem),22.75rem)] gap-0 p-5 text-center"
      >
        <AlertDialogHeader className="items-center space-y-0 text-center">
          <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-muted">
            <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={2} aria-hidden />
          </div>
          <AlertDialogTitle className="text-center text-[14px] font-medium leading-5 text-foreground">
            {t(titleKey, { name: resourceName })}
          </AlertDialogTitle>
          <AlertDialogDescription className="mt-2 max-w-[17rem] text-center text-[12px] leading-4 text-muted-foreground">
            {t(descriptionKey)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="mt-5 grid grid-cols-2 gap-2.5 space-x-0">
          <AlertDialogCancel
            onClick={onCancel}
          >
            {t(cancelKey)}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
          >
            {t(confirmKey)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
