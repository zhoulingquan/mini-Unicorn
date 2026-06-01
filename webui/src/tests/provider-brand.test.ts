import { describe, expect, it } from "vitest";

import { faviconUrls, logoFallbackUrls, providerBrand } from "@/lib/provider-brand";

describe("provider brand logos", () => {
  it("uses multiple favicon sources before falling back to initials", () => {
    expect(faviconUrls("z.ai")).toEqual([
      "https://z.ai/favicon.ico",
      "https://icons.duckduckgo.com/ip3/z.ai.ico",
      "https://www.google.com/s2/favicons?domain=z.ai&sz=64",
    ]);
  });

  it("keeps explicit Google favicon URLs first before trying fallbacks", () => {
    expect(logoFallbackUrls("https://www.google.com/s2/favicons?domain=browserbase.com&sz=64")).toEqual([
      "https://www.google.com/s2/favicons?domain=browserbase.com&sz=64",
      "https://browserbase.com/favicon.ico",
      "https://icons.duckduckgo.com/ip3/browserbase.com.ico",
    ]);
  });

  it("normalizes path-like favicon domains for secondary fallbacks", () => {
    expect(logoFallbackUrls("https://www.google.com/s2/favicons?domain=github.com/HKUDS/CLI-Anything&sz=64")).toEqual([
      "https://www.google.com/s2/favicons?domain=github.com/HKUDS/CLI-Anything&sz=64",
      "https://github.com/favicon.ico",
      "https://icons.duckduckgo.com/ip3/github.com.ico",
      "https://www.google.com/s2/favicons?domain=github.com%2FHKUDS%2FCLI-Anything&sz=64",
    ]);
  });

  it("keeps DeepSeek on its brand domain", () => {
    expect(providerBrand("deepseek")?.logoUrls[0]).toBe("https://deepseek.com/favicon.ico");
    expect(providerBrand("deepseek")?.logoUrls).toContain("https://www.google.com/s2/favicons?domain=deepseek.com&sz=64");
    expect(providerBrand("deepseek")?.initials).toBe("DS");
  });

  it("uses official first-party assets for OpenCode", () => {
    expect(providerBrand("opencode")?.logoUrls[0]).toBe("https://opencode.ai/favicon.ico");
    expect(providerBrand("opencode")?.logoUrls).toContain("https://www.google.com/s2/favicons?domain=opencode.ai&sz=64");
    expect(providerBrand("opencode")?.initials).toBe("OC");
  });
});
