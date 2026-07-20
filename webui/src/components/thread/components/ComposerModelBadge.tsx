import { useEffect, useState } from "react";

import { Sparkles } from "lucide-react";

import { inferProviderFromModelName, providerBrand } from "@/lib/provider-brand";
import { cn } from "@/lib/utils";

export interface ComposerModelBadgeProps {
  label: string;
  provider?: string | null;
  providerLabel?: string | null;
  isHero: boolean;
}

/** 输入框右下角的模型徽章,展示模型名 + provider 图标(logo 失败时回退首字母)。 */
export function ComposerModelBadge({
  label,
  provider,
  providerLabel,
  isHero,
}: ComposerModelBadgeProps) {
  const inferredProvider = provider || inferProviderFromModelName(label);
  const brand = providerBrand(inferredProvider);
  const [logoIndex, setLogoIndex] = useState(0);
  const logoUrl = brand?.logoUrls[logoIndex];
  const showLogo = !!logoUrl;
  const title = providerLabel ? `${label} · ${providerLabel}` : label;

  useEffect(() => setLogoIndex(0), [inferredProvider]);

  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center rounded-full border border-border/55 bg-card font-medium text-foreground/82",
        "shadow-[0_2px_8px_rgba(15,23,42,0.045)]",
        isHero ? "h-8 max-w-[12.5rem] gap-1.5 px-2 text-[11.5px]" : "h-9 max-w-[12rem] gap-2 px-2.5 text-[12px]",
      )}
    >
      <span
        data-testid={inferredProvider ? `composer-model-logo-${inferredProvider}` : "composer-model-logo"}
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-full border bg-background",
          isHero ? "h-[18px] w-[18px]" : "h-5 w-5",
        )}
        style={{
          borderColor: brand ? `${brand.color}28` : undefined,
          boxShadow: brand ? `inset 0 0 0 1px ${brand.color}18` : undefined,
        }}
        aria-hidden
      >
        {showLogo ? (
          <img
            src={logoUrl}
            alt=""
            className={cn("object-contain", isHero ? "h-3 w-3" : "h-3.5 w-3.5")}
            onError={() => setLogoIndex((index) => index + 1)}
          />
        ) : brand ? (
          <span
            className={cn(
              "grid h-full w-full place-items-center rounded-full text-white",
              isHero ? "text-[7.5px]" : "text-[8px]",
            )}
            style={{ backgroundColor: brand.color }}
          >
            {brand.initials.slice(0, 2)}
          </span>
        ) : (
          <Sparkles className={cn("text-muted-foreground/65", isHero ? "h-3 w-3" : "h-3 w-3")} />
        )}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}
