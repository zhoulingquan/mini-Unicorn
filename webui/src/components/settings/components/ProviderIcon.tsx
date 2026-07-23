// Provider 图标组件:ProviderIcon / ProviderPickerIcon 与共享的 PROVIDER_ICONS 映射。
// 从 SettingsView.tsx 拆分,供 ProvidersSettings / ProviderPicker / ModelPresetPicker 复用。

import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  Bot,
  Cloud,
  Cpu,
  Database,
  Gem,
  Grid3X3,
  Hexagon,
  Layers,
  Moon,
  Orbit,
  Search,
  Sparkles,
  Triangle,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { providerBrand, faviconUrls, type ProviderBrand } from "@/lib/provider-brand";

/** 从 api_base URL 提取 host(用于 custom provider 动态生成 brand)。
 *  返回去除通用前缀(www/api/apihub/gateway)后的域名,如 apihub.agnes-ai.com → agnes-ai.com */
function hostFromApiBase(apiBase: string | null | undefined): string | null {
  if (!apiBase) return null;
  try {
    const parsed = new URL(apiBase);
    let host = parsed.hostname.toLowerCase();
    // 去掉通用前缀
    host = host.replace(/^(www|api|apihub|api-gateway|gateway)\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/** 从 host 生成首字母(取第一段非通用前缀的首字母,大写) */
function initialsFromHost(host: string | null): string {
  if (!host) return "C";
  const firstPart = host.split(".")[0];
  return firstPart.charAt(0).toUpperCase() || "C";
}

/** 从 host 生成稳定颜色(基于域名 hash → HSL) */
function colorFromHost(host: string | null): string {
  if (!host) return "#6B7280";
  let hash = 0;
  for (let i = 0; i < host.length; i++) {
    hash = host.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}

export const PROVIDER_ICONS: Record<string, LucideIcon> = {
  custom: Hexagon,
  openrouter: Sparkles,
  skywork: Sparkles,
  aihubmix: Triangle,
  anthropic: Brain,
  openai: Bot,
  deepseek: Waves,
  zhipu: Grid3X3,
  dashscope: Cloud,
  moonshot: Moon,
  minimax: Zap,
  minimax_anthropic: Brain,
  groq: Cpu,
  huggingface: Layers,
  gemini: Gem,
  mistral: Orbit,
  siliconflow: Layers,
  volcengine: Cloud,
  volcengine_coding_plan: Cloud,
  byteplus: Cloud,
  byteplus_coding_plan: Cloud,
  qianfan: Database,
  ant_ling: Sparkles,
  azure_openai: Cloud,
  bedrock: Database,
  brave: Search,
  duckduckgo: Search,
  exa: Search,
  jina: Search,
  kagi: Search,
  olostep: Search,
  tavily: Search,
  vllm: Cpu,
  ollama: Cpu,
  lm_studio: Cpu,
  atomic_chat: Cpu,
  ovms: Cpu,
  nvidia: Zap,
};

export function ProviderIcon({
  provider,
  showBrandLogos,
  label,
  apiBase,
}: {
  provider: string;
  showBrandLogos: boolean;
  label?: string | null;
  apiBase?: string | null;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  // preset 虚拟卡片(<provider>__<preset_name>):用真实 provider 的 brand 显示图标。
  // - custom preset (custom__<name>): 与 custom 单例一致,根据 api_base 动态生成
  //   favicon + 首字母 + 稳定颜色;无 api_base 时回退到 custom brand 颜色 + label 首字母
  // - 非 custom preset (如 opencode__<name>): 用真实 provider 的 brand,正常显示 logo
  const isPresetCard = provider.includes("__");
  const isCustomPreset = provider.startsWith("custom__");
  const lookupKey = isPresetCard ? provider.split("__", 2)[0] : provider;
  const baseBrand = providerBrand(lookupKey);
  // custom provider(单例或虚拟 preset 卡片):根据 api_base 动态生成 brand,
  // 用域名 favicon 作为 logo、首字母作为 initials、hash 域名生成稳定颜色。
  const customHost = useMemo(
    () => (lookupKey === "custom" ? hostFromApiBase(apiBase) : null),
    [lookupKey, apiBase],
  );
  const brand: ProviderBrand | null = useMemo(() => {
    // custom(单例或虚拟卡片)有 api_base:用域名生成 favicon + 颜色 + 首字母
    if (lookupKey === "custom" && customHost) {
      const urls = faviconUrls(customHost);
      return {
        logoUrl: urls[0] ?? "",
        logoUrls: urls,
        color: colorFromHost(customHost),
        initials: initialsFromHost(customHost),
      };
    }
    // custom preset 无 api_base:回退到 custom brand 颜色 + label 首字母
    if (isCustomPreset && baseBrand) {
      return {
        logoUrl: "",
        logoUrls: [],
        color: baseBrand.color,
        initials: (label?.trim().charAt(0).toUpperCase() || baseBrand.initials),
      };
    }
    return baseBrand;
  }, [isCustomPreset, baseBrand, lookupKey, customHost, label]);
  const Icon = PROVIDER_ICONS[lookupKey] ?? Hexagon;
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider, customHost]);

  if (showBrandLogos && logoUrl) {
    return (
      <span
        data-testid={`provider-logo-${provider}`}
        className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[14px] border border-border/45 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
      >
        <img
          src={logoUrl}
          alt=""
          className="h-6 w-6 object-contain"
          onError={() => setLogoIndex((index) => index + 1)}
        />
      </span>
    );
  }
  if (showBrandLogos && brand) {
    return (
      <span
        data-testid={`provider-logo-fallback-${provider}`}
        className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[14px] border border-border/45 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
        aria-hidden
      >
        <span
          className="text-[13px] font-semibold"
          style={{ color: brand.color }}
        >
          {brand.initials}
        </span>
      </span>
    );
  }
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-muted text-foreground/82 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)] dark:bg-muted/70">
      <Icon className="h-5 w-5" strokeWidth={2} aria-hidden />
    </span>
  );
}

export function ProviderPickerIcon({
  provider,
  showBrandLogos,
}: {
  provider: string;
  showBrandLogos: boolean;
}) {
  const [logoIndex, setLogoIndex] = useState(0);
  const brand = providerBrand(provider);
  const Icon = PROVIDER_ICONS[provider] ?? Sparkles;
  const logoUrl = brand?.logoUrls[logoIndex];

  useEffect(() => setLogoIndex(0), [provider]);

  if (showBrandLogos && logoUrl) {
    return (
      <span
        data-testid={`provider-picker-logo-${provider}`}
        className="grid h-5 w-5 shrink-0 place-items-center overflow-hidden rounded-md border border-border/35 bg-background shadow-[inset_0_0_0_1px_rgba(0,0,0,0.02)]"
        style={{ boxShadow: `inset 0 0 0 1px ${brand.color}22` }}
        aria-hidden
      >
        <img
          src={logoUrl}
          alt=""
          className="h-3.5 w-3.5 object-contain"
          onError={() => setLogoIndex((index) => index + 1)}
        />
      </span>
    );
  }

  if (showBrandLogos && brand) {
    return (
      <span
        data-testid={`provider-picker-logo-fallback-${provider}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[7.5px] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]"
        style={{ backgroundColor: brand.color }}
        aria-hidden
      >
        {brand.initials}
      </span>
    );
  }

  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      aria-hidden
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}
