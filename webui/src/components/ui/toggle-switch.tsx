import { cn } from "@/lib/utils";

export interface ToggleSwitchProps {
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel: string;
  className?: string;
}

/** Small accessible toggle switch used by cards across settings-style views. */
export function ToggleSwitch({
  checked,
  disabled,
  onClick,
  ariaLabel,
  className,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-violet-500" : "bg-muted-foreground/30",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
