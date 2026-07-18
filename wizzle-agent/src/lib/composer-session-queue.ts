import type { PreviewFile } from "../types/workspace";
import { CONTEXT_CONTINUE_PROMPT } from "./agent/context-pressure";
import { loadComposerState, saveComposerState } from "./local-workspace";

/**
 * Session-scoped composer queue that survives Composer unmount (#43).
 * Composer is a view; drain is driven by send completion / wake / hydrate.
 */

export type ComposerQueueItemStatus = "queued" | "sending" | "failed";

/** Internal auto-continue after context pressure; user items are default. */
export type ComposerQueueItemKind = "user" | "context_continue";

export type ComposerQueueItem = {
  attachments: PreviewFile[];
  id: string;
  /** Defaults to "user" when omitted (persisted / legacy items). */
  kind?: ComposerQueueItemKind;
  prompt: string;
  status: ComposerQueueItemStatus;
};

/** Queue SQL predates item kinds, so restore the internal marker from its stable prompt. */
export function inferComposerQueueItemKind(prompt: string): ComposerQueueItemKind {
  return prompt === CONTEXT_CONTINUE_PROMPT ? "context_continue" : "user";
}

const queuesBySessionId = new Map<string, ComposerQueueItem[]>();
const listenersBySessionId = new Map<string, Set<() => void>>();
const drainingSessionIds = new Set<string>();

/** Stable empty snapshot for useSyncExternalStore — never return a fresh `[]` (React #185). */
const EMPTY_COMPOSER_QUEUE: ComposerQueueItem[] = [];

function notify(sessionId: string) {
  const listeners = listenersBySessionId.get(sessionId);
  if (!listeners) {
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}

export function getComposerSessionQueue(sessionId: string): ComposerQueueItem[] {
  return queuesBySessionId.get(sessionId) ?? EMPTY_COMPOSER_QUEUE;
}

export function setComposerSessionQueue(sessionId: string, items: ComposerQueueItem[]) {
  if (items.length === 0) {
    // Keep a stable empty snapshot; remove the map entry so get returns EMPTY_COMPOSER_QUEUE.
    const hadEntry = queuesBySessionId.delete(sessionId);
    if (hadEntry) {
      notify(sessionId);
    }
    return;
  }

  queuesBySessionId.set(
    sessionId,
    items.map((item) => ({
      ...item,
      attachments: [...item.attachments],
      status: item.status ?? "queued",
    })),
  );
  notify(sessionId);
}

export function subscribeComposerSessionQueue(sessionId: string, onStoreChange: () => void) {
  const listeners = listenersBySessionId.get(sessionId) ?? new Set();
  listeners.add(onStoreChange);
  listenersBySessionId.set(sessionId, listeners);

  return () => {
    const current = listenersBySessionId.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(onStoreChange);
    if (current.size === 0) {
      listenersBySessionId.delete(sessionId);
    }
  };
}

export function selectNextQueuedComposerItem(items: readonly ComposerQueueItem[]) {
  // Prefer an internal context-continue so it runs ahead of user-queued prompts.
  const continueItem = items.find(
    (item) =>
      (item.status ?? "queued") === "queued" && item.kind === "context_continue",
  );
  if (continueItem) {
    return continueItem;
  }

  return items.find((item) => (item.status ?? "queued") === "queued") ?? null;
}

/** A sending item is already represented by its accepted user message in chat. */
export function selectVisibleComposerQueueItems(items: readonly ComposerQueueItem[]) {
  return items.filter((item) => item.status !== "sending");
}

export function markComposerQueueItemStatus(
  items: readonly ComposerQueueItem[],
  itemId: string,
  status: ComposerQueueItemStatus,
): ComposerQueueItem[] {
  return items.map((item) => (item.id === itemId ? { ...item, status } : item));
}

export function removeComposerQueueItem(
  items: readonly ComposerQueueItem[],
  itemId: string,
): ComposerQueueItem[] {
  return items.filter((item) => item.id !== itemId);
}

export type ComposerQueueSendResult = {
  accepted: boolean;
  error?: string;
  ok: boolean;
  retryable?: boolean;
};

export function applyComposerQueueSendResult(
  items: readonly ComposerQueueItem[],
  itemId: string,
  result: ComposerQueueSendResult,
): ComposerQueueItem[] {
  if (result.accepted) {
    return removeComposerQueueItem(items, itemId);
  }

  if (result.retryable) {
    return markComposerQueueItemStatus(items, itemId, "queued");
  }

  return markComposerQueueItemStatus(items, itemId, "failed");
}

export function createComposerQueueItem(options: {
  attachments: PreviewFile[];
  kind?: ComposerQueueItemKind;
  prompt: string;
}): ComposerQueueItem {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `queue-${crypto.randomUUID()}`
      : `queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    attachments: options.attachments,
    id,
    kind: options.kind ?? "user",
    prompt: options.prompt,
    status: "queued",
  };
}

/**
 * Enqueue at most one context-continue at the front. Replaces any other queued
 * context_continue items so pressure does not stack duplicate continues.
 */
export async function enqueueContextContinue(
  sessionId: string,
  prompt: string,
): Promise<ComposerQueueItem> {
  const item = createComposerQueueItem({
    attachments: [],
    kind: "context_continue",
    prompt,
  });
  const existing = getComposerSessionQueue(sessionId).filter(
    (entry) => entry.kind !== "context_continue" || entry.status === "sending",
  );
  setComposerSessionQueue(sessionId, [item, ...existing]);
  await persistQueueOnly(sessionId, getComposerSessionQueue(sessionId));
  return item;
}

/** Drop queued (not in-flight) context_continue items — e.g. user stop. */
export function cancelQueuedContextContinues(sessionId: string): ComposerQueueItem[] {
  const next = getComposerSessionQueue(sessionId).filter(
    (item) => item.kind !== "context_continue" || item.status === "sending",
  );
  setComposerSessionQueue(sessionId, next);
  void persistQueueOnly(sessionId, next);
  return next;
}

async function persistQueueOnly(sessionId: string, items: ComposerQueueItem[]) {
  try {
    const existing = await loadComposerState(sessionId);
    await saveComposerState({
      draftText: existing.draftText ?? "",
      queuedMessages: items.map((item) => ({
        attachments: item.attachments,
        content: item.prompt,
        id: item.id,
        status: item.status,
      })),
      sessionId,
    });
  } catch {
    // Best-effort; in-memory queue still drains.
  }
}

export type DrainComposerSessionQueueDeps = {
  isSessionSending: (sessionId: string) => boolean;
  resolveProjectIdForSession: (sessionId: string) => string | null;
  sendPrompt: (
    prompt: string,
    attachments: PreviewFile[],
    options?: { forceCompaction?: boolean; projectId?: string; sessionId?: string },
  ) => Promise<ComposerQueueSendResult>;
};

/**
 * Drain at most one queued item for a session. Safe to call when Composer is unmounted.
 * Schedules another pass if more items remain and the session is still idle.
 */
export async function drainComposerSessionQueue(
  sessionId: string,
  deps: DrainComposerSessionQueueDeps,
): Promise<void> {
  if (!sessionId || drainingSessionIds.has(sessionId)) {
    return;
  }

  if (deps.isSessionSending(sessionId)) {
    return;
  }

  const items = getComposerSessionQueue(sessionId);
  const next = selectNextQueuedComposerItem(items);
  if (!next) {
    return;
  }

  const projectId = deps.resolveProjectIdForSession(sessionId);
  if (!projectId) {
    setComposerSessionQueue(
      sessionId,
      markComposerQueueItemStatus(items, next.id, "failed"),
    );
    await persistQueueOnly(sessionId, getComposerSessionQueue(sessionId));
    return;
  }

  drainingSessionIds.add(sessionId);
  setComposerSessionQueue(sessionId, markComposerQueueItemStatus(items, next.id, "sending"));

  try {
    const result = await deps.sendPrompt(next.prompt, next.attachments, {
      forceCompaction: next.kind === "context_continue",
      projectId,
      sessionId,
    });
    const nextItems = applyComposerQueueSendResult(
      getComposerSessionQueue(sessionId),
      next.id,
      result,
    );
    setComposerSessionQueue(sessionId, nextItems);
    await persistQueueOnly(sessionId, nextItems);
  } catch {
    const nextItems = markComposerQueueItemStatus(
      getComposerSessionQueue(sessionId),
      next.id,
      "failed",
    );
    setComposerSessionQueue(sessionId, nextItems);
    await persistQueueOnly(sessionId, nextItems);
  } finally {
    drainingSessionIds.delete(sessionId);
  }

  // Chain if still idle and more work remains.
  if (
    !deps.isSessionSending(sessionId) &&
    selectNextQueuedComposerItem(getComposerSessionQueue(sessionId))
  ) {
    queueMicrotask(() => {
      void drainComposerSessionQueue(sessionId, deps);
    });
  }
}

/** Hydrate module queue from persisted composer state (first load / remount). */
export function hydrateComposerSessionQueue(
  sessionId: string,
  items: ComposerQueueItem[],
  options?: { overwrite?: boolean },
) {
  if (!options?.overwrite && queuesBySessionId.has(sessionId)) {
    return;
  }
  setComposerSessionQueue(sessionId, items);
}

/**
 * Move queue items from a draft session id to the promoted real session (#45).
 * In-flight "sending" items become "queued" again under the new id.
 */
export function rekeyComposerSessionQueue(
  fromSessionId: string,
  toSessionId: string,
): ComposerQueueItem[] {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
    return getComposerSessionQueue(toSessionId);
  }

  const fromItems = getComposerSessionQueue(fromSessionId);
  const toItems = getComposerSessionQueue(toSessionId);
  const moved = fromItems.map((item) =>
    item.status === "sending" ? { ...item, status: "queued" as const } : { ...item },
  );
  const merged = [...toItems, ...moved];
  setComposerSessionQueue(toSessionId, merged);

  if (queuesBySessionId.has(fromSessionId)) {
    queuesBySessionId.delete(fromSessionId);
    notify(fromSessionId);
  }

  return merged;
}

/** Rekey in-memory queue and best-effort persist under the new session id. */
export async function migrateComposerSessionQueue(
  fromSessionId: string,
  toSessionId: string,
): Promise<ComposerQueueItem[]> {
  const merged = rekeyComposerSessionQueue(fromSessionId, toSessionId);
  if (merged.length > 0) {
    await persistQueueOnly(toSessionId, merged);
  }
  return merged;
}

/** Test helper: clear all in-memory queues. */
export function resetComposerSessionQueuesForTests() {
  queuesBySessionId.clear();
  listenersBySessionId.clear();
  drainingSessionIds.clear();
}
