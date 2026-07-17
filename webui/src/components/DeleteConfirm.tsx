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
import { useTranslation } from "react-i18next";

interface DeleteConfirmProps {
  open: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirm({
  open,
  title,
  onCancel,
  onConfirm,
}: DeleteConfirmProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <AlertDialogContent
        className="max-w-sm rounded-[22px] border-border/70 bg-popover p-5 shadow-2xl"
      >
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>{t("deleteConfirm.title", { title })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteConfirm.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <AlertDialogCancel onClick={onCancel}>
            {t("deleteConfirm.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("deleteConfirm.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
