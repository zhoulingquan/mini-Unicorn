// 默认 @mention 内置 fixture：用于 ThreadComposer 的 mention picker 与
// MessageBubble 的 chip 渲染。生产环境中，ThreadShell 会在 fetch
// `/api/settings/cli-apps` 与 `/api/settings/mcp-presets` 后通过
// `CLI_APPS_CHANGED_EVENT` / `MCP_PRESETS_CHANGED_EVENT` 广播真实数据，
// 覆盖此默认值。这些 fixture 主要服务于组件级单测，让 ThreadComposer 与
// MessageBubble 在无任何 props/事件注入的情况下也能展示已知应用清单。
import type { CliAppInfo, McpPresetInfo } from "@/lib/types";

/** 已安装的 CLI 应用 fixture。顺序即 picker 展示顺序。 */
export const DEFAULT_INSTALLED_CLI_APPS: CliAppInfo[] = [
  {
    name: "gimp",
    display_name: "GIMP",
    category: "image",
    description: "Image editing",
    requires: "",
    source: "harness",
    entry_point: "cli-anything-gimp",
    install_supported: true,
    installed: true,
    available: true,
    status: "installed",
    logo_url: null,
    brand_color: "#5C5543",
    skill_installed: true,
  },
  {
    name: "blender",
    display_name: "Blender",
    category: "3d",
    description: "3D rendering",
    requires: "",
    source: "harness",
    entry_point: "cli-anything-blender",
    install_supported: true,
    installed: true,
    available: true,
    status: "installed",
    logo_url: null,
    brand_color: "#E87D0D",
    skill_installed: true,
  },
  ...Array.from({ length: 6 }, (_, i) => {
    const idx = i + 2;
    return {
      name: `app-${idx}`,
      display_name: `App ${idx}`,
      category: "general",
      description: `Sample app ${idx}`,
      requires: "",
      source: "harness",
      entry_point: `cli-anything-app-${idx}`,
      install_supported: true,
      installed: true,
      available: true,
      status: "installed" as const,
      logo_url: null,
      brand_color: "#6366F1",
      skill_installed: true,
    };
  }),
  {
    name: "zoom",
    display_name: "Zoom",
    category: "video",
    description: "Video meetings",
    requires: "",
    source: "harness",
    entry_point: "cli-anything-zoom",
    install_supported: true,
    installed: true,
    available: true,
    status: "installed",
    logo_url: null,
    brand_color: "#0B5CFF",
    skill_installed: true,
  },
];

/** 未安装的 CLI 应用 fixture。这些应用存在于 catalog 中，但未安装，
 * 因此 picker 不显示，且在 MessageBubble 中以普通文本呈现。 */
export const DEFAULT_NOT_INSTALLED_CLI_APPS: CliAppInfo[] = [
  {
    name: "krita",
    display_name: "Krita",
    category: "image",
    description: "Digital painting",
    requires: "",
    source: "harness",
    entry_point: "cli-anything-krita",
    install_supported: true,
    installed: false,
    available: true,
    status: "available",
    logo_url: null,
    brand_color: null,
    skill_installed: false,
  },
];

/** 已配置的 MCP 预设 fixture。 */
export const DEFAULT_CONFIGURED_MCP_PRESETS: McpPresetInfo[] = [
  {
    name: "browserbase",
    display_name: "Browserbase",
    category: "browser",
    description: "Browser automation",
    docs_url: "",
    transport: "streamableHttp",
    requires: "",
    note: "",
    install_supported: true,
    installed: true,
    configured: true,
    available: true,
    status: "configured",
    logo_url: "https://example.invalid/browserbase.svg",
    brand_color: "#111827",
    required_fields: [],
    connection_summary: "",
  },
];

/** 未配置的 MCP 预设 fixture。 */
export const DEFAULT_NOT_CONFIGURED_MCP_PRESETS: McpPresetInfo[] = [
  {
    name: "figma",
    display_name: "Figma",
    category: "design",
    description: "Design files",
    docs_url: "",
    transport: "stdio",
    requires: "",
    note: "",
    install_supported: true,
    installed: false,
    configured: false,
    available: true,
    status: "not_installed",
    logo_url: null,
    brand_color: null,
    required_fields: [],
    connection_summary: "",
  },
];

/** 全量 CLI catalog fixture（已安装 + 未安装），用于 MessageBubble 判断
 * 某个 `@name` 是否为已知 CLI 应用（进而决定是否渲染为 chip）。 */
export const DEFAULT_CLI_APPS_CATALOG: CliAppInfo[] = [
  ...DEFAULT_INSTALLED_CLI_APPS,
  ...DEFAULT_NOT_INSTALLED_CLI_APPS,
];

/** 全量 MCP catalog fixture。 */
export const DEFAULT_MCP_PRESETS_CATALOG: McpPresetInfo[] = [
  ...DEFAULT_CONFIGURED_MCP_PRESETS,
  ...DEFAULT_NOT_CONFIGURED_MCP_PRESETS,
];
