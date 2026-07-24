import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MessageBubble } from "@/components/MessageBubble";
import {
  AgentActivityCluster,
  isAgentActivityMember,
} from "@/components/thread/AgentActivityCluster";
import type { UIMessage } from "@/lib/types";

interface ThreadMessagesProps {
  messages: UIMessage[];
  isStreaming?: boolean;
  hiddenMessageCount?: number;
  onLoadEarlier?: () => void;
  /** Called when the user clicks the rewind button under the N-th user message. */
  onRewind?: (userMessageIndex: number) => void;
  /** Called when the user clicks the retry button under an assistant reply.
   * The ``userMessageIndex`` is the index of the user turn that produced the
   * reply being retried. */
  onRetry?: (userMessageIndex: number) => void;
  /** Number of user messages hidden above the visible window. The backend's
   * user message index is based on the full conversation, so this offset is
   * added to the visible-window index when invoking rewind/retry. */
  userMessageIndexOffset?: number;
}

export type DisplayUnit =
  | { type: "cluster"; messages: UIMessage[] }
  | { type: "single"; message: UIMessage };

/** True when this unit index is the last assistant text slice before the next user message (or end of thread). */
export function isFinalAssistantSliceBeforeNextUser(
  units: DisplayUnit[],
  index: number,
): boolean {
  const u = units[index];
  if (u.type !== "single" || u.message.role !== "assistant") return true;
  for (let j = index + 1; j < units.length; j++) {
    const v = units[j];
    if (v.type === "single" && v.message.role === "user") break;
    return false;
  }
  return true;
}

export function buildDisplayUnits(messages: UIMessage[]): DisplayUnit[] {
  const out: DisplayUnit[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (isAgentActivityMember(m)) {
      const cluster: UIMessage[] = [];
      let segmentId: string | undefined = m.activitySegmentId;
      let clusterHasFileEdits = hasFileEdits(m);
      while (
        i < messages.length
        && isAgentActivityMember(messages[i])
        && canJoinActivityCluster(segmentId, clusterHasFileEdits, messages[i])
      ) {
        const current = messages[i];
        if (!segmentId && current.activitySegmentId) {
          segmentId = current.activitySegmentId;
        }
        clusterHasFileEdits = clusterHasFileEdits || hasFileEdits(current);
        cluster.push(current);
        i += 1;
      }
      pushActivityCluster(out, cluster);
      continue;
    }
    const previous = out[out.length - 1];
    if (
      previous?.type === "cluster"
      && assistantHasInlineReasoning(m)
      && canFoldInlineReasoning(previous.messages, m)
    ) {
      previous.messages.push(reasoningOnlyMessageFromAnswer(m));
      out.push({ type: "single", message: stripInlineReasoning(m) });
      i += 1;
      continue;
    }
    if (assistantHasInlineReasoning(m)) {
      out.push({ type: "cluster", messages: [reasoningOnlyMessageFromAnswer(m)] });
      out.push({ type: "single", message: stripInlineReasoning(m) });
      i += 1;
      continue;
    }
    out.push({ type: "single", message: m });
    i += 1;
  }
  return out;
}

function pushActivityCluster(out: DisplayUnit[], cluster: UIMessage[]) {
  const previous = out[out.length - 1];
  if (
    previous?.type !== "single"
    || !shouldPlaceLateActivityBeforeAssistant(out, previous.message)
  ) {
    out.push({ type: "cluster", messages: cluster });
    return;
  }

  const beforeAssistant = out[out.length - 2];
  if (beforeAssistant?.type === "cluster" && canMergeActivityClusters(beforeAssistant.messages, cluster)) {
    beforeAssistant.messages.push(...cluster);
    return;
  }

  out.splice(out.length - 1, 0, { type: "cluster", messages: cluster });
}

function shouldPlaceLateActivityBeforeAssistant(out: DisplayUnit[], message: UIMessage): boolean {
  if (message.role !== "assistant" || message.kind === "trace") return false;
  if (message.isStreaming) return true;
  if (hasTurnLatency(message)) return true;

  const beforeAssistant = out[out.length - 2];
  return beforeAssistant?.type === "cluster";
}

function hasTurnLatency(message: UIMessage): boolean {
  return (
    typeof message.latencyMs === "number"
    && Number.isFinite(message.latencyMs)
    && message.latencyMs >= 0
  );
}

function clusterSegmentId(messages: UIMessage[]): string | undefined {
  return messages.find((message) => message.activitySegmentId)?.activitySegmentId;
}

function hasFileEdits(message: UIMessage): boolean {
  return !!message.fileEdits?.length;
}

function clusterHasFileEdits(messages: UIMessage[]): boolean {
  return messages.some(hasFileEdits);
}

function canJoinActivityCluster(
  clusterSegmentId: string | undefined,
  clusterIncludesFileEdits: boolean,
  message: UIMessage,
): boolean {
  const messageHasFileEdits = hasFileEdits(message);
  if (!clusterIncludesFileEdits && !messageHasFileEdits) return true;
  if (!clusterSegmentId || !message.activitySegmentId) return true;
  return clusterSegmentId === message.activitySegmentId;
}

function canFoldInlineReasoning(cluster: UIMessage[], message: UIMessage): boolean {
  if (!clusterHasFileEdits(cluster) && !hasFileEdits(message)) return true;
  const segmentId = clusterSegmentId(cluster);
  if (!segmentId || !message.activitySegmentId) return true;
  return segmentId === message.activitySegmentId;
}

function canMergeActivityClusters(target: UIMessage[], incoming: UIMessage[]): boolean {
  let segmentId = clusterSegmentId(target);
  let includesFileEdits = clusterHasFileEdits(target);
  for (const message of incoming) {
    if (!canJoinActivityCluster(segmentId, includesFileEdits, message)) return false;
    if (!segmentId && message.activitySegmentId) {
      segmentId = message.activitySegmentId;
    }
    includesFileEdits = includesFileEdits || hasFileEdits(message);
  }
  return true;
}

function assistantHasInlineReasoning(message: UIMessage): boolean {
  return (
    message.role === "assistant"
    && message.kind !== "trace"
    && message.content.trim().length > 0
    && (!!message.reasoning?.trim() || !!message.reasoningStreaming)
  );
}

function reasoningOnlyMessageFromAnswer(message: UIMessage): UIMessage {
  return {
    id: `${message.id}-reasoning`,
    role: "assistant",
    content: "",
    createdAt: message.createdAt,
    reasoning: message.reasoning,
    reasoningStreaming: message.reasoningStreaming,
    isStreaming: message.reasoningStreaming,
    activitySegmentId: message.activitySegmentId,
    latencyMs: message.latencyMs,
  };
}

function stripInlineReasoning(message: UIMessage): UIMessage {
  const next = { ...message };
  delete next.reasoning;
  delete next.reasoningStreaming;
  return next;
}

export function assistantCopyFlags(units: DisplayUnit[]): boolean[] {
  const flags = new Array<boolean>(units.length).fill(true);
  let hasLaterUnitBeforeUser = false;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit.type === "single" && unit.message.role === "user") {
      hasLaterUnitBeforeUser = false;
      continue;
    }
    if (unit.type === "single" && unit.message.role === "assistant") {
      flags[i] = !hasLaterUnitBeforeUser;
    }
    hasLaterUnitBeforeUser = true;
  }
  return flags;
}

export function ThreadMessages({
  messages,
  isStreaming = false,
  hiddenMessageCount = 0,
  onLoadEarlier,
  onRewind,
  onRetry,
  userMessageIndexOffset = 0,
}: ThreadMessagesProps) {
  const { t } = useTranslation();
  const units = useMemo(() => buildDisplayUnits(messages), [messages]);
  const copyFlags = useMemo(() => assistantCopyFlags(units), [units]);
  const liveActivityClusterIndex = useMemo(
    () => isStreaming ? currentActivityClusterIndex(units) : -1,
    [isStreaming, units],
  );

  // Pre-compute the 0-based user message index for each single unit so the
  // rewind/retry callbacks can identify the target user turn without scanning
  // the message list on every click. Cluster units (tool traces, reasoning)
  // inherit the user index of the assistant turn they belong to (i.e. the
  // most recent user message at that point).
  const userIndexByUnit = useMemo(() => {
    const out: number[] = new Array(units.length).fill(-1);
    let userCount = -1;
    for (let i = 0; i < units.length; i += 1) {
      const u = units[i];
      if (u.type === "single" && u.message.role === "user" && u.message.kind !== "trace") {
        userCount += 1;
      }
      out[i] = userCount;
    }
    return out;
  }, [units]);

  // 当正在流式输出但消息列表中尚无正在流式的 assistant 消息(即等待首字节阶段),
  // 在消息列表末尾显示"等待回复…"spinner 指示器。
  const showAwaitingReplyIndicator = useMemo(() => {
    if (!isStreaming || units.length === 0) return false;
    // 检查最后一条消息是否是正在流式的 assistant 消息
    for (let i = units.length - 1; i >= 0; i -= 1) {
      const u = units[i];
      if (u.type === "single") {
        if (u.message.role === "assistant" && u.message.isStreaming) return false;
        // 最后一条非 assistant 流式消息(如用户消息)→ 处于等待回复阶段
        return true;
      }
      // cluster:检查是否包含正在流式的 assistant 消息
      const hasStreamingAssistant = u.messages.some(
        (m) => m.role === "assistant" && m.isStreaming,
      );
      return !hasStreamingAssistant;
    }
    return true;
  }, [isStreaming, units]);

  const disableActions = isStreaming;

  return (
    <div className="flex w-full flex-col">
      {hiddenMessageCount > 0 && onLoadEarlier ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            onClick={onLoadEarlier}
            className="rounded-full border border-border/60 bg-background/85 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:bg-muted/55 hover:text-foreground"
          >
            {t("thread.loadEarlier", {
              count: hiddenMessageCount,
              defaultValue: "Load earlier messages",
            })}
          </button>
        </div>
      ) : null}
      {units.map((unit, index) => {
        const prev = units[index - 1];
        const marginTop =
          index > 0
            ? marginAfterPrevUnit(prev)
            : "";
        const next = units[index + 1];
        const hasBodyBelow =
          unit.type === "cluster"
          && next?.type === "single"
          && next.message.role === "assistant";
        const turnLatencyMs =
          unit.type === "cluster" ? activityClusterTurnLatencyMs(unit.messages, next) : undefined;

        // Rewind: show on user messages only (not trace). Disabled while streaming.
        const handleRewind =
          unit.type === "single"
          && unit.message.role === "user"
          && unit.message.kind !== "trace"
          && onRewind
          && userIndexByUnit[index] >= 0
            ? () => onRewind!(userIndexByUnit[index] + userMessageIndexOffset)
            : undefined;

        // Retry: show on assistant answer slices only (not trace, not streaming).
        // The retry target is the user turn that produced this reply, which is
        // the most recent user message at this unit's position.
        const handleRetry =
          unit.type === "single"
          && unit.message.role === "assistant"
          && unit.message.kind !== "trace"
          && !unit.message.isStreaming
          && onRetry
          && userIndexByUnit[index] >= 0
            ? () => onRetry!(userIndexByUnit[index] + userMessageIndexOffset)
            : undefined;

        const isUserTurn =
          unit.type === "single"
          && unit.message.role === "user"
          && unit.message.kind !== "trace";

        return (
          <div
            key={unitKey(unit, index)}
            className={marginTop}
            data-user-turn={isUserTurn ? unit.message.id : undefined}
          >
            {unit.type === "cluster" ? (
              <AgentActivityCluster
                messages={unit.messages}
                isTurnStreaming={index === liveActivityClusterIndex}
                hasBodyBelow={hasBodyBelow}
                turnLatencyMs={turnLatencyMs}
              />
            ) : (
              <MessageBubble
                message={unit.message}
                showAssistantCopyAction={
                  unit.message.role === "assistant"
                    ? copyFlags[index]
                    : true
                }
                onRewind={handleRewind}
                onRetry={handleRetry}
                disableActions={disableActions}
              />
            )}
          </div>
        );
      })}
      {showAwaitingReplyIndicator && (
        <div className="mt-2 w-full text-[15px]" style={{ lineHeight: "var(--cjk-line-height)" }}>
          <div className="inline-flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{t("thread.awaitingReply", { defaultValue: "等待回复…" })}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function activityClusterTurnLatencyMs(
  messages: UIMessage[],
  next: DisplayUnit | undefined,
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const latency = messages[i].latencyMs;
    if (typeof latency === "number" && Number.isFinite(latency) && latency >= 0) {
      return latency;
    }
  }
  if (
    next?.type === "single"
    && next.message.role === "assistant"
    && typeof next.message.latencyMs === "number"
    && Number.isFinite(next.message.latencyMs)
    && next.message.latencyMs >= 0
  ) {
    return next.message.latencyMs;
  }
  return undefined;
}

function currentActivityClusterIndex(units: DisplayUnit[]): number {
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit.type === "cluster") return i;
    if (unit.message.role === "assistant" && unit.message.isStreaming) continue;
    if (unit.message.role === "user") break;
    return -1;
  }
  return -1;
}

function unitKey(unit: DisplayUnit, index: number): string {
  if (unit.type === "cluster") {
    const anchor = unit.messages[0]?.id;
    return anchor != null ? `cluster-${anchor}` : `cluster-idx-${index}`;
  }
  return unit.message.id;
}

function marginAfterPrevUnit(prev: DisplayUnit): string {
  if (prev.type === "cluster") {
    return "mt-4";
  }
  const p = prev.message;
  const denseP =
    p.kind === "trace"
    || (
      p.role === "assistant"
      && p.content.trim().length === 0
      && (!!p.reasoning || !!p.reasoningStreaming)
    );
  if (denseP) {
    return "mt-2";
  }
  return "mt-5";
}
