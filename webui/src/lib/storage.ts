/**
 * Centralised localStorage key registry for the webui.
 *
 * Historically keys were declared inline in each module with slightly
 * different naming conventions (`miniUnicorn-webui.`, `miniUnicorn.webui.`,
 * `miniUnicorn:`, `miniUnicorn_debug_`). This object is the single source of
 * truth: new code should always reference `STORAGE_KEYS.*` rather than
 * hand-rolling a string literal.
 */
export const STORAGE_KEYS = {
  /** Auth bootstrap secret persisted between page reloads. */
  bootstrapSecret: "miniUnicorn-webui.bootstrap-secret",
  /** Sidebar collapsed/expanded state. */
  sidebar: "miniUnicorn-webui.sidebar",
  /** Sidebar "completed runs" badge tracking (versioned). */
  sidebarCompletedRuns: "miniUnicorn-webui.sidebar.completed-runs.v1",
  /** Timestamp marking when a host restart was initiated. */
  restartStartedAt: "miniUnicorn-webui.restartStartedAt",
  /** Per-user UI density / activity / brand preferences. */
  settingsPreferences: "miniUnicorn-webui.settings-preferences",
  /** Cached provider model lists (cleared on settings reload). */
  providerModels: "miniUnicorn:providerModels",
  /** Last-selected UI theme. */
  theme: "miniUnicorn-webui.theme",
  /** Selected i18n locale. */
  locale: "miniUnicorn.locale",
  /** Recently-used slash commands (composer autocomplete). */
  slashCommandRecents: "miniUnicorn.webui.slashCommandRecents",
  /** Debug flag for the WebSocket client. */
  debugWs: "miniUnicorn_debug_ws",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
