/**
 * User-facing copy for provider stream / agent step failures (#19 approach C).
 * Zero-output transient failures are retried by the provider layer. Once any
 * output exists, partial content stays and the error is shown under the bubble.
 */

export type SessionStreamError = {
  message: string;
  turnId: string;
};

export function formatStreamStepUserMessage(
  error: string,
  options: { hadPartialContent?: boolean } = {},
) {
  const base =
    error.trim() || "Wizzle could not complete the reply.";

  if (options.hadPartialContent) {
    return `${base} Partial content is kept above.`;
  }

  return base;
}

/** True when the turn already has visible assistant output (stream started). */
export function turnHasPartialAssistantContent(
  messages: readonly { role: string; content?: string; turnId?: string; parts?: { type: string; content?: string }[] }[],
  turnId: string,
) {
  return messages.some((message) => {
    if (message.turnId !== turnId || message.role !== "assistant") {
      return false;
    }

    if ((message.content ?? "").trim().length > 0) {
      return true;
    }

    return (message.parts ?? []).some(
      (part) =>
        (part.type === "content" || part.type === "activity_content") &&
        (part.content ?? "").trim().length > 0,
    );
  });
}

export function clearSessionStreamErrorMap(
  map: Record<string, SessionStreamError | undefined>,
  sessionId: string,
): Record<string, SessionStreamError | undefined> {
  if (!sessionId || !(sessionId in map)) {
    return map;
  }

  const next = { ...map };
  delete next[sessionId];
  return next;
}

export function setSessionStreamErrorMap(
  map: Record<string, SessionStreamError | undefined>,
  sessionId: string,
  error: SessionStreamError,
): Record<string, SessionStreamError | undefined> {
  if (!sessionId) {
    return map;
  }

  return {
    ...map,
    [sessionId]: error,
  };
}
