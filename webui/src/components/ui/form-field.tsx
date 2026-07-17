import * as React from "react";

import { cn } from "@/lib/utils";

export interface FormFieldProps {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** Generic labelled form field wrapper used across settings-style dialogs. */
export function FormField({ label, required, children, className }: FormFieldProps) {
  return (
    <div className={cn("space-y-1", className)}>
      <label className="text-[11px] font-medium text-muted-foreground/80">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
