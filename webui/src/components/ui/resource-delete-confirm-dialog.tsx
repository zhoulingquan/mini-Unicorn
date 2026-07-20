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
import { cn } from "@/lib/utils";

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
        className={cn(
          "w-[min(calc(100vw-2rem),22.75rem)] gap-0 rounded-[22px] p-5 text-center",
          "border border-border bg-background shadow-[0_22px_70px_rgba(0,0,0,0.22)]",
          "dark:border-white/14 dark:bg-[#2b2b2b] dark:shadow-[0_26px_90px_rgba(0,0,0,0.44)]",
          "sm:rounded-[22px] data-[state=open]:zoom-in-95",
        )}
      >
        <AlertDialogHeader className="items-center space-y-0 text-center">
          <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-muted">
            <Icon className="h-4.5 w-4.5 text-muted-foreground" strokeWidth={2} aria-hidden />
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
            className="mt-0 h-10 rounded-[11px] border-0 bg-muted px-4 text-[14px] font-medium text-foreground shadow-none hover:bg-muted/80"
          >
            {t(cancelKey)}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="h-10 rounded-[11px] bg-foreground px-4 text-[14px] font-medium text-background shadow-none hover:bg-foreground/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
          >
            {t(confirmKey)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
