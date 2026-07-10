/** Pure helpers for per-session sending isolation (#27 / #79 / #46). */

export function resolveIsSendingMessage(
  selectedSessionId: string | null | undefined,
  sendingSessionIds: readonly string[],
) {
  return Boolean(selectedSessionId && sendingSessionIds.includes(selectedSessionId));
}

export function addSendingSessionId(sessionId: string, current: readonly string[]) {
  return current.includes(sessionId) ? [...current] : [...current, sessionId];
}

export function removeSendingSessionId(sessionId: string, current: readonly string[]) {
  return current.filter((id) => id !== sessionId);
}

export function shouldShowSessionInterrupt(options: {
  hasDraftContent: boolean;
  selectedSessionId: string | null | undefined;
  sendingSessionIds: readonly string[];
}) {
  return (
    resolveIsSendingMessage(options.selectedSessionId, options.sendingSessionIds) &&
    !options.hasDraftContent
  );
}

export function shouldRestoreComposerDraft(result: { accepted: boolean }) {
  return !result.accepted;
}
