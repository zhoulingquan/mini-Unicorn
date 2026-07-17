import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { ThreadHeader } from "@/components/thread/ThreadHeader";
import { StreamErrorNotice } from "@/components/thread/StreamErrorNotice";
import { ThreadViewport } from "@/components/thread/ThreadViewport";
import { useMiniUnicornStream, type SendImage, type SendOptions } from "@/hooks/useMiniUnicornStream";
import type { ThemeMode } from "@/hooks/useTheme";
import { useSessionHistory } from "@/hooks/useSessions";
import { fetchAgents, fetchSettings, listSlashCommands } from "@/lib/api";
import { inferProviderFromModelName, providerDisplayLabel } from "@/lib/provider-brand";
import type {
  AgentInfo,
  ChatSummary,
  SettingsPayload,
  SlashCommand,
  UIMessage,
  WorkspaceScopePayload,
  WorkspacesPayload,
} from "@/lib/types";
import { normalizeLegacyLongTaskMessages } from "@/lib/thread-display-compat";
import { scrubSubagentUiMessages } from "@/lib/subagent-channel-display";
import { useClient } from "@/providers/ClientProvider";

function projectWebuiThreadMessages(messages: UIMessage[]): UIMessage[] {
  return scrubSubagentUiMessages(normalizeLegacyLongTaskMessages(messages));
}

function sameMessageShape(a: UIMessage, b: UIMessage): boolean {
  return (
    a.role === b.role
    && (a.kind ?? "") === (b.kind ?? "")
    && a.content === b.content
  );
}

function isStaleThreadSnapshot(current: UIMessage[], snapshot: UIMessage[]): boolean {
  if (current.length === 0 || snapshot.length >= current.length) return false;
  if (snapshot.length === 0) return true;
  return snapshot.every((message, index) => sameMessageShape(current[index], message));
}

interface ThreadShellProps {
  session: ChatSummary | null;
  title: string;
  onToggleSidebar: () => void;
  onGoHome?: () => void;
  onNewChat?: () => void;
  onCreateChat?: (workspaceScope?: WorkspaceScopePayload | null) => Promise<string | null>;
  onTurnEnd?: () => void;
  theme?: "light" | "dark";
  themeMode?: ThemeMode;
  onToggleTheme?: () => void;
  onToggleLanguage?: () => void;
  hideSidebarToggleForHostChrome?: boolean;
  hideHeader?: boolean;
  workspaceScope?: WorkspaceScopePayload | null;
  workspaceDefaultScope?: WorkspaceScopePayload | null;
  workspaceControls?: WorkspacesPayload["controls"] | null;
  workspaceScopeDisabled?: boolean;
  workspaceError?: string | null;
  onWorkspaceScopeChange?: (scope: WorkspaceScopePayload) => void;
  settingsSnapshot?: SettingsPayload | null;
  /** Currently selected subagent id (routes outbound turns to that agent). */
  selectedAgentId?: string | null;
  /** Called when the user picks a subagent in the composer. */
  onSelectAgent?: (agentId: string) => void;
  /** Called when the user clears the active subagent selection. */
  onClearAgent?: () => void;
}

function toModelBadgeLabel(modelName: string | null): string | null {
  if (!modelName) return null;
  const trimmed = modelName.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split("/").pop() ?? trimmed;
  return leaf || trimmed;
}

interface ModelBadgeInfo {
  label: string | null;
  provider: string | null;
  providerLabel: string | null;
}

function activeModelPreset(settings: SettingsPayload | null): SettingsPayload["model_presets"][number] | null {
  if (!settings) return null;
  const configured = settings.agent.model_preset || "default";
  return (
    settings.model_presets.find((preset) => preset.name === configured)
    ?? settings.model_presets.find((preset) => preset.active)
    ?? null
  );
}

function resolvedModelProvider(settings: SettingsPayload | null, modelName: string | null): string | null {
  const preset = activeModelPreset(settings);
  const rawProvider = preset?.provider || settings?.agent.provider || null;
  if (rawProvider === "auto") {
    return settings?.agent.resolved_provider || inferProviderFromModelName(modelName) || null;
  }
  return rawProvider || inferProviderFromModelName(modelName);
}

function toModelBadgeInfo(modelName: string | null, settings: SettingsPayload | null): ModelBadgeInfo {
  const label = toModelBadgeLabel(modelName || settings?.agent.model || null);
  const provider = resolvedModelProvider(settings, modelName || settings?.agent.model || null);
  return {
    label,
    provider,
    providerLabel: provider ? providerDisplayLabel(settings?.providers ?? [], provider) : null,
  };
}

const HERO_GREETING_KEYS = [
  "thread.empty.greetings.workOn",
  "thread.empty.greetings.start",
  "thread.empty.greetings.build",
  "thread.empty.greetings.tackle",
] as const;

function randomHeroGreetingKey(): (typeof HERO_GREETING_KEYS)[number] {
  const index = Math.floor(Math.random() * HERO_GREETING_KEYS.length);
  return HERO_GREETING_KEYS[index] ?? HERO_GREETING_KEYS[0];
}

interface PendingFirstMessage {
  content: string;
  images?: SendImage[];
  options?: SendOptions;
}

export function ThreadShell({
  session,
  title,
  onToggleSidebar,
  onCreateChat,
  onTurnEnd,
  theme = "light",
  themeMode,
  onToggleTheme = () => {},
  onToggleLanguage = () => {},
  hideSidebarToggleForHostChrome = false,
  hideHeader = false,
  workspaceScope = null,
  workspaceDefaultScope = null,
  workspaceControls = null,
  workspaceScopeDisabled = false,
  workspaceError = null,
  onWorkspaceScopeChange,
  settingsSnapshot = null,
  selectedAgentId = null,
  onSelectAgent,
  onClearAgent,
}: ThreadShellProps) {
  const { t } = useTranslation();
  const chatId = session?.chatId ?? null;
  const historyKey = session?.key ?? null;
  const {
    messages: historical,
    loading,
    hasPendingToolCalls,
    refresh: refreshHistory,
    version: historyVersion,
  } = useSessionHistory(historyKey);
  const { client, modelName, token } = useClient();
  const [booting, setBooting] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [settings, setSettings] = useState<SettingsPayload | null>(settingsSnapshot);
  const [heroGreetingKey, setHeroGreetingKey] = useState(randomHeroGreetingKey);
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);
  const pendingFirstRef = useRef<PendingFirstMessage | null>(null);

  // ---------------------------------------------------------------------------
  // Thread message cache — 6 refs that cooperate to keep per-chat in-memory
  // thread state alive across session switches.
  //
  // DATA FOW
  //   messageCacheRef  ─►  `initial` (useMemo)  ─►  useMiniUnicornStream
  //        ▲                                              │
  //        │                                              ▼
  //   sync effects ◄── setMessages / messages ────────────┘
  //
  // Because `useMiniUnicornStream` consumes `initial` (which reads
  // `messageCacheRef`) **and** produces `setMessages` / `messages` that the
  // cache-sync effects write back, these refs cannot be cleanly extracted into
  // a standalone hook without creating a circular dependency. They are kept
  // inline and documented below.
  //
  // REF INVENTORY
  //   messageCacheRef            chatId → projected UIMessage[] (live thread)
  //   prevChatIdForCacheRef      last chatId rendered; drives cache-on-switch
  //   skipLayoutCacheRef         suppress one cache write after a chat switch
  //                              (the first paint still sees the old chat's
  //                              messages from useMiniUnicornStream's reset)
  //   appliedHistoryVersionRef   chatId → last historyVersion merged into the
  //                              live thread (prevents re-applying stale snaps)
  //   pendingCanonicalHydrateRef chatIds awaiting a fresh canonical replay
  //                              (set on `session_updated`, cleared once the
  //                              new history has been merged)
  //   sessionKeyByChatIdRef      chatId → sessionKey mapping for telemetry
  // ---------------------------------------------------------------------------
  const messageCacheRef = useRef<Map<string, UIMessage[]>>(new Map());
  const prevChatIdForCacheRef = useRef<string | null>(null);
  const skipLayoutCacheRef = useRef(false);
  const appliedHistoryVersionRef = useRef<Map<string, number>>(new Map());
  const pendingCanonicalHydrateRef = useRef<Set<string>>(new Set());
  const sessionKeyByChatIdRef = useRef<Map<string, string>>(new Map());

  const initial = useMemo(() => {
    if (!chatId) return historical;
    return messageCacheRef.current.get(chatId) ?? historical;
  }, [chatId, historical]);
  const handleTurnEnd = useCallback(() => {
    onTurnEnd?.();
  }, [onTurnEnd]);
  const {
    messages,
    isStreaming,
    runStartedAt,
    goalState,
    contextUsage,
    send,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMiniUnicornStream(chatId, initial, hasPendingToolCalls, handleTurnEnd);

  useEffect(() => {
    if (chatId && historyKey) sessionKeyByChatIdRef.current.set(chatId, historyKey);
  }, [chatId, historyKey]);

  const displayMessages = useMemo(() => projectWebuiThreadMessages(messages), [messages]);

  // 上下文消息条数:仅统计 user/assistant 对话回合,不计入 trace(工具提示)行。
  const conversationMessageCount = useMemo(
    () => displayMessages.filter((m) => m.kind !== "trace").length,
    [displayMessages],
  );
  const contextWindowTokens =
    settings?.agent.resolved_context_window_tokens ??
    settings?.agent.context_window_tokens ??
    null;

  const showHeroComposer = messages.length === 0 && !loading;
  const wasShowingHeroComposerRef = useRef(showHeroComposer);
  const modelBadge = useMemo(
    () => toModelBadgeInfo(modelName, settings),
    [modelName, settings],
  );

  useEffect(() => {
    if (showHeroComposer && !wasShowingHeroComposerRef.current) {
      setHeroGreetingKey(randomHeroGreetingKey());
    }
    wasShowingHeroComposerRef.current = showHeroComposer;
  }, [showHeroComposer]);

  const withWorkspaceScope = useCallback(
    (options?: SendOptions): SendOptions | undefined => {
      if (!workspaceScope) return options;
      return {
        ...(options ?? {}),
        workspaceScope,
      };
    },
    [workspaceScope],
  );

  const refreshModelSettings = useCallback(async () => {
    try {
      setSettings(await fetchSettings(token));
    } catch {
      if (!settingsSnapshot) setSettings(null);
    }
  }, [settingsSnapshot, token]);

  useEffect(() => {
    if (settingsSnapshot) {
      setSettings(settingsSnapshot);
      return;
    }
    void refreshModelSettings();
  }, [refreshModelSettings, settingsSnapshot]);

  useEffect(() => {
    return client.onRuntimeModelUpdate(() => {
      void refreshModelSettings();
    });
  }, [client, refreshModelSettings]);

  // Canonical history hydration — merges fetched history into the live thread.
  // Reads: messageCacheRef, appliedHistoryVersionRef, pendingCanonicalHydrateRef.
  // Writes: messageCacheRef, appliedHistoryVersionRef, pendingCanonicalHydrateRef.
  useEffect(() => {
    if (!chatId || loading) return;
    const cached = messageCacheRef.current.get(chatId);
    const appliedVersion = appliedHistoryVersionRef.current.get(chatId) ?? 0;
    const hasPendingCanonicalHydrate = pendingCanonicalHydrateRef.current.has(chatId);
    const hasNewCanonicalHistory = hasPendingCanonicalHydrate && historyVersion > appliedVersion;
    // When the user switches away and back, keep the local in-memory thread
    // state (including not-yet-persisted messages) instead of replacing it with
    // whatever the history endpoint currently knows about. Once a fresh
    // canonical replay arrives (e.g. after ``session_updated`` refresh), prefer it
    // so rendering converges to the same shape as a manual refresh.
    setMessages((prev) => {
      const normalizedHistory = projectWebuiThreadMessages(historical);
      const keepLiveMessages = (messagesToKeep: UIMessage[]) => {
        const projected = projectWebuiThreadMessages(messagesToKeep);
        messageCacheRef.current.set(chatId, projected);
        return projected;
      };
      if (hasNewCanonicalHistory && historical.length > 0) {
        if (isStaleThreadSnapshot(prev, normalizedHistory)) return keepLiveMessages(prev);
        pendingCanonicalHydrateRef.current.delete(chatId);
        appliedHistoryVersionRef.current.set(chatId, historyVersion);
        messageCacheRef.current.set(chatId, normalizedHistory);
        return normalizedHistory;
      }
      if (cached && cached.length > 0) {
        const normalizedCached = projectWebuiThreadMessages(cached);
        if (isStaleThreadSnapshot(prev, normalizedCached)) return keepLiveMessages(prev);
        return normalizedCached;
      }
      if (isStaleThreadSnapshot(prev, normalizedHistory)) return keepLiveMessages(prev);
      appliedHistoryVersionRef.current.set(chatId, historyVersion);
      if (normalizedHistory.length > 0) messageCacheRef.current.set(chatId, normalizedHistory);
      return normalizedHistory;
    });
  }, [loading, chatId, historical, historyVersion, setMessages]);

  // Marks a chat as pending canonical hydration when the backend signals a
  // session update, then triggers a history refresh.
  // Writes: pendingCanonicalHydrateRef.
  useEffect(() => {
    if (!chatId) return;
    return client.onSessionUpdate((updatedChatId, scope) => {
      if (updatedChatId !== chatId) return;
      if (scope === "metadata") return;
      pendingCanonicalHydrateRef.current.add(chatId);
      refreshHistory();
    });
  }, [chatId, client, refreshHistory]);

  useEffect(() => {
    if (!chatId || loading) return;
    setScrollToBottomSignal((value) => value + 1);
  }, [chatId, loading, historical]);

  useEffect(() => {
    if (chatId) return;
    setMessages(projectWebuiThreadMessages(historical));
  }, [chatId, historical, setMessages]);

  // Cache-on-switch — runs synchronously before paint to snapshot the outgoing
  // chat's messages into messageCacheRef and arm skipLayoutCacheRef so the
  // post-paint persist effect doesn't overwrite it with stale data.
  // Reads: prevChatIdForCacheRef. Writes: messageCacheRef, skipLayoutCacheRef, prevChatIdForCacheRef.
  useLayoutEffect(() => {
    if (chatId) {
      const prev = prevChatIdForCacheRef.current;
      if (prev && prev !== chatId) {
        messageCacheRef.current.set(prev, projectWebuiThreadMessages(messages));
        skipLayoutCacheRef.current = true;
      }
      prevChatIdForCacheRef.current = chatId;
    } else {
      if (prevChatIdForCacheRef.current) {
        messageCacheRef.current.set(
          prevChatIdForCacheRef.current,
          projectWebuiThreadMessages(messages),
        );
        skipLayoutCacheRef.current = true;
      }
      prevChatIdForCacheRef.current = null;
    }
  }, [chatId, messages]);

  // Persist thread to in-memory cache after paint so ``useMiniUnicornStream``'s chat switch
  // ``useEffect`` reset has flushed; ``skipLayoutCacheRef`` drops the first run that still
  // sees the *previous* chat's ``messages`` (avoids stale rows leaking across sessions).
  useEffect(() => {
    if (!chatId) {
      return;
    }
    if (skipLayoutCacheRef.current) {
      skipLayoutCacheRef.current = false;
      return;
    }
    if (loading) {
      return;
    }
    messageCacheRef.current.set(chatId, projectWebuiThreadMessages(messages));
  }, [chatId, loading, messages]);

  useEffect(() => {
    if (!chatId) return;
    const pending = pendingFirstRef.current;
    if (!pending) return;
    pendingFirstRef.current = null;
    setScrollToBottomSignal((value) => value + 1);
    send(pending.content, pending.images, pending.options);
    setBooting(false);
  }, [chatId, send]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const commands = await listSlashCommands(token);
        if (!cancelled) setSlashCommands(commands);
      } catch {
        if (!cancelled) setSlashCommands([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Fetch available subagents for the composer selector. Refresh on token change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await fetchAgents(token);
        if (!cancelled) setAgents(payload.agents);
      } catch {
        if (!cancelled) setAgents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleWelcomeSend = useCallback(
    async (content: string, images?: SendImage[], options?: SendOptions) => {
      if (booting) return;
      setBooting(true);
      pendingFirstRef.current = { content, images, options: withWorkspaceScope(options) };
      const newId = await onCreateChat?.(workspaceScope);
      if (!newId) {
        pendingFirstRef.current = null;
        setBooting(false);
      }
    },
    [booting, onCreateChat, withWorkspaceScope, workspaceScope],
  );

  const handleThreadSend = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      setScrollToBottomSignal((value) => value + 1);
      send(content, images, withWorkspaceScope(options));
    },
    [send, withWorkspaceScope],
  );

  const composer = (
    <>
      {streamError ? (
        <StreamErrorNotice
          error={streamError}
          onDismiss={dismissStreamError}
        />
      ) : null}
      {session ? (
        <ThreadComposer
          onSend={handleThreadSend}
          disabled={!chatId}
          isStreaming={isStreaming}
          placeholder={
            showHeroComposer
              ? t("thread.composer.placeholderHero")
              : t("thread.composer.placeholderThread")
          }
          modelLabel={modelBadge.label}
          modelProvider={modelBadge.provider}
          modelProviderLabel={modelBadge.providerLabel}
          variant={showHeroComposer ? "hero" : "thread"}
          slashCommands={slashCommands}
          onStop={stop}
          runStartedAt={runStartedAt}
          goalState={goalState}
          workspaceScope={workspaceScope}
          workspaceDefaultScope={workspaceDefaultScope}
          workspaceControls={workspaceControls}
          workspaceScopeDisabled={workspaceScopeDisabled}
          workspaceError={workspaceError}
          onWorkspaceScopeChange={onWorkspaceScopeChange}
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
          onClearAgent={onClearAgent}
          messageCount={conversationMessageCount}
          contextWindowTokens={contextWindowTokens}
          contextUsage={contextUsage}
          conversationKey={historyKey}
        />
      ) : (
        <ThreadComposer
          onSend={handleWelcomeSend}
          disabled={booting}
          isStreaming={isStreaming}
          placeholder={
            booting
              ? t("thread.composer.placeholderOpening")
              : t("thread.composer.placeholderHero")
          }
          modelLabel={modelBadge.label}
          modelProvider={modelBadge.provider}
          modelProviderLabel={modelBadge.providerLabel}
          variant="hero"
          slashCommands={slashCommands}
          runStartedAt={runStartedAt}
          goalState={goalState}
          workspaceScope={workspaceScope}
          workspaceDefaultScope={workspaceDefaultScope}
          workspaceControls={workspaceControls}
          workspaceScopeDisabled={workspaceScopeDisabled}
          workspaceError={workspaceError}
          onWorkspaceScopeChange={onWorkspaceScopeChange}
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={onSelectAgent}
          onClearAgent={onClearAgent}
          messageCount={conversationMessageCount}
          contextWindowTokens={contextWindowTokens}
          contextUsage={contextUsage}
        />
      )}
    </>
  );

  const emptyState = loading ? (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t("thread.loadingConversation")}
    </div>
  ) : (
    <div className="flex w-full flex-col items-center text-center animate-in fade-in-0 slide-in-from-bottom-2 duration-500">
      <h1 className="text-balance text-[40px] font-normal leading-tight tracking-[-0.045em] text-foreground sm:text-[48px]">
        {t(heroGreetingKey)}
      </h1>
    </div>
  );

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {!hideHeader ? (
        <ThreadHeader
          title={title}
          onToggleSidebar={onToggleSidebar}
          theme={theme}
          themeMode={themeMode}
          onToggleTheme={onToggleTheme}
          onToggleLanguage={onToggleLanguage}
          hideSidebarToggleForHostChrome={hideSidebarToggleForHostChrome}
          minimal={!session && !loading}
          modelLabel={modelBadge.label}
          modelProvider={modelBadge.provider}
        />
      ) : null}
      <ThreadViewport
        messages={displayMessages}
        isStreaming={isStreaming}
        emptyState={emptyState}
        composer={composer}
        scrollToBottomSignal={scrollToBottomSignal}
        conversationKey={historyKey}
        showScrollToBottomButton={!!session}
      />
    </section>
  );
}
