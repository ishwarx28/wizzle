/**
 * Settled-turn durable persistence: best-effort message/summary writes, then
 * always attempt finalize so turns do not stay stuck in `running`.
 */

export type SettledTurnPersistResult = {
  finalizeError: string | null;
  messageErrors: string[];
  summaryError: string | null;
};

export function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

/** True when Rust rejects a write because the turn is already terminal. */
export function isTurnAlreadyFinalizedError(error: unknown) {
  const message = getErrorMessage(error, "").toLowerCase();
  return message.includes("already finalized") && message.includes("cannot be updated");
}

/**
 * Persist turn messages best-effort (continue after individual failures),
 * then summary, then always finalize. Finalize runs even when message writes fail.
 */
export async function runSettledTurnPersistence(options: {
  finalize: () => Promise<void>;
  persistMessage: (messageId: string) => Promise<void>;
  messageIds: string[];
  persistSummary?: () => Promise<void>;
}): Promise<SettledTurnPersistResult> {
  const messageErrors: string[] = [];

  for (const messageId of options.messageIds) {
    try {
      await options.persistMessage(messageId);
    } catch (error) {
      if (isTurnAlreadyFinalizedError(error)) {
        continue;
      }

      messageErrors.push(
        getErrorMessage(error, `Could not save message ${messageId}.`),
      );
    }
  }

  let summaryError: string | null = null;

  if (options.persistSummary) {
    try {
      await options.persistSummary();
    } catch (error) {
      if (!isTurnAlreadyFinalizedError(error)) {
        summaryError = getErrorMessage(error, "Could not save the turn summary.");
      }
    }
  }

  let finalizeError: string | null = null;

  try {
    await options.finalize();
  } catch (error) {
    finalizeError = getErrorMessage(error, "Could not finalize the turn.");
  }

  return {
    finalizeError,
    messageErrors,
    summaryError,
  };
}

export function describeSettledTurnPersistResult(result: SettledTurnPersistResult) {
  if (result.finalizeError) {
    return `The reply finished, but Wizzle could not close the turn: ${result.finalizeError}`;
  }

  const parts: string[] = [];

  if (result.messageErrors.length > 0) {
    parts.push(
      result.messageErrors.length === 1
        ? result.messageErrors[0]!
        : `${result.messageErrors.length} messages could not be saved.`,
    );
  }

  if (result.summaryError) {
    parts.push(result.summaryError);
  }

  if (parts.length === 0) {
    return null;
  }

  return `The reply finished, but some chat data may not be fully saved. ${parts.join(" ")}`;
}

/** True when settle ran but finalize/message/summary durable writes were incomplete (#44). */
export function isSettledTurnPersistIncomplete(
  result: SettledTurnPersistResult | null | undefined,
): boolean {
  if (!result) {
    return false;
  }

  return Boolean(
    result.finalizeError ||
      result.summaryError ||
      result.messageErrors.length > 0,
  );
}
