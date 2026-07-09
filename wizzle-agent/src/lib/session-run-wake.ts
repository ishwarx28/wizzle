/**
 * Session run coalesce / wake drain (#29).
 * Rust finish_session_run returns true when a concurrent begin set wake_requested.
 * Frontend must honor that and re-drain follow-up work (composer queue / retry).
 */

export const SESSION_RUN_WAKE_EVENT = "wizzle:session-run-wake";

export const SESSION_ALREADY_RUNNING_ERROR = "That session already has an active run.";

export function isSessionAlreadyRunningError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.includes("already has an active run");
}

export function shouldWakeFollowUpRun(finishReturnedWake: boolean): boolean {
  return finishReturnedWake === true;
}

/** Build a CustomEvent detail for composer/store listeners. */
export function buildSessionRunWakeDetail(sessionId: string) {
  return { sessionId };
}

export function dispatchSessionRunWake(sessionId: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(SESSION_RUN_WAKE_EVENT, {
      detail: buildSessionRunWakeDetail(sessionId),
    }),
  );
}

/**
 * After finishSessionRun: if wake was requested, call wakeSessionRun (keeps
 * coordinator intent) and notify UI to drain queued/retryable work.
 */
export async function completeSessionRunFinish(options: {
  finish: () => Promise<boolean>;
  sessionId: string;
  wake: (sessionId: string) => Promise<unknown>;
}): Promise<{ shouldWake: boolean }> {
  const shouldWake = shouldWakeFollowUpRun(await options.finish());

  if (!shouldWake) {
    return { shouldWake: false };
  }

  try {
    await options.wake(options.sessionId);
  } catch {
    // Wake is best-effort; drain still proceeds so the queue is not stuck.
  }

  dispatchSessionRunWake(options.sessionId);
  return { shouldWake: true };
}
