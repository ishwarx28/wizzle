import type { Message, ModelId, Session } from "../types/workspace";
import {
  formatStreamStepUserMessage,
  turnHasPartialAssistantContent,
  type SessionStreamError,
} from "./stream-step-error";

const STALE_CONTINUE_SUFFIX = /\s+Send a new message to continue\.\s*$/i;

export const FAILED_TURN_MARKER_KEY = "wizzleFailedTurn";

export type RecoverableSessionStreamError = SessionStreamError & {
  modelId: ModelId;
  hadPartialContent: boolean;
};

export type PersistedFailedTurnMarker = {
  error: string;
  hadPartialContent: boolean;
  modelId: ModelId;
  turnId: string;
};

export type FailedTurnRetryTranscript = {
  keepTurnIds: string[];
  messages: Message[];
  userMessage: Message;
};

export function compactFailedTurnError(message: string, maxLength = 180) {
  const normalized = message
    .replace(STALE_CONTINUE_SUFFIX, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = "The reply could not be completed.";
  const concise = normalized || fallback;

  if (concise.length <= maxLength) {
    return concise;
  }

  return `${concise.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedFailedTurnMarker(message: Message): PersistedFailedTurnMarker | null {
  for (const part of [...(message.parts ?? [])].reverse()) {
    const candidate = part.metadata?.[FAILED_TURN_MARKER_KEY];
    if (
      !isRecord(candidate) ||
      typeof candidate.error !== "string" ||
      typeof candidate.hadPartialContent !== "boolean" ||
      typeof candidate.modelId !== "string" ||
      typeof candidate.turnId !== "string"
    ) {
      continue;
    }

    return {
      error: candidate.error,
      hadPartialContent: candidate.hadPartialContent,
      modelId: candidate.modelId,
      turnId: candidate.turnId,
    };
  }

  return null;
}

/** Recover the latest actionable failed turn from durable message state. */
export function recoverSessionStreamError(
  session: Session,
): RecoverableSessionStreamError | null {
  const latestTurnId = [...session.messages]
    .reverse()
    .find((message) => message.turnId)?.turnId;
  if (!latestTurnId) {
    return null;
  }

  const turnMessages = session.messages.filter((message) => message.turnId === latestTurnId);
  const marker = [...turnMessages]
    .reverse()
    .filter((message) => message.role === "assistant")
    .map(persistedFailedTurnMarker)
    .find(
      (candidate): candidate is PersistedFailedTurnMarker =>
        candidate?.turnId === latestTurnId,
    );
  const hasFailedAssistant = turnMessages.some(
    (message) => message.role === "assistant" && message.status === "error",
  );
  if (!marker && !hasFailedAssistant) {
    return null;
  }

  const modelId = marker?.modelId ?? session.selectedModelUuid ?? session.modelId ?? "";
  if (!modelId) {
    return null;
  }

  const hadPartialContent =
    marker?.hadPartialContent ?? turnHasPartialAssistantContent(turnMessages, latestTurnId);
  const rawError = marker?.error || "Wizzle could not complete the previous reply.";

  return {
    hadPartialContent,
    message: formatStreamStepUserMessage(rawError, { hadPartialContent }),
    modelId,
    turnId: latestTurnId,
  };
}

/** Remove the failed attempt while retaining exactly one existing user anchor. */
export function prepareFailedTurnRetryTranscript(
  messages: Message[],
  turnId: string,
): FailedTurnRetryTranscript | null {
  const userIndex = messages.findIndex(
    (message) => message.role === "user" && message.turnId === turnId,
  );
  if (userIndex < 0) {
    return null;
  }

  const existingUserMessage = messages[userIndex]!;
  const userMessage: Message = {
    ...existingUserMessage,
    isStored: false,
    status: "done",
  };
  const retainedPrefix = messages.slice(0, userIndex);
  const keepTurnIds = Array.from(
    new Set(
      retainedPrefix
        .map((message) => message.turnId)
        .filter((candidate): candidate is string => Boolean(candidate) && candidate !== turnId),
    ),
  );

  return {
    keepTurnIds,
    messages: [...retainedPrefix, userMessage],
    userMessage,
  };
}

/** Remove summaries and context markers that reference the deleted failed suffix. */
export function applyFailedTurnRetryTranscript(
  session: Session,
  prepared: FailedTurnRetryTranscript,
  selection: { modelId: ModelId; reasoningLevel: string },
) {
  const retainedTurnIds = new Set(prepared.keepTurnIds);
  session.messages = prepared.messages;
  session.modelId = selection.modelId;
  session.reasoningLevel = selection.reasoningLevel;
  session.selectedModelUuid = selection.modelId;
  session.replayTurnSummaries = (session.replayTurnSummaries ?? []).filter((summary) =>
    retainedTurnIds.has(summary.turnId),
  );

  if (session.compactedContext) {
    const compactedTurnIds = session.compactedContext.compactedTurnIds.filter((turnId) =>
      retainedTurnIds.has(turnId),
    );
    session.compactedContext =
      compactedTurnIds.length > 0
        ? { ...session.compactedContext, compactedTurnIds }
        : null;
  }

  const retainedMessageCount = prepared.messages.length;
  session.events = (session.events ?? []).filter(
    (event) => event.phase === "compacted" && event.afterMessageCount <= retainedMessageCount,
  );
}
