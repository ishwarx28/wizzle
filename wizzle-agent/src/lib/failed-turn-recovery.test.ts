import type { Message, Session } from "../types/workspace.ts";
import {
  applyFailedTurnRetryTranscript,
  compactFailedTurnError,
  prepareFailedTurnRetryTranscript,
  recoverSessionStreamError,
} from "./failed-turn-recovery.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function message(input: Partial<Message> & Pick<Message, "id" | "role" | "turnId">): Message {
  return {
    content: "",
    createdAtLabel: "now",
    status: "done",
    ...input,
  };
}

function main() {
  assert(
    compactFailedTurnError(
      "Upstream request failed. Partial content is kept above. Send a new message to continue.",
    ) === "Upstream request failed. Partial content is kept above.",
    "stale continue guidance is removed while the partial-content warning remains",
  );
  assert(
    compactFailedTurnError("  Provider\n  request   failed.  ") === "Provider request failed.",
    "stream errors are normalized to one compact line",
  );
  assert(
    compactFailedTurnError("Partial content is kept above.") === "Partial content is kept above.",
    "partial-content information remains visible",
  );

  const truncated = compactFailedTurnError("A".repeat(40), 12);
  assert(truncated === `${"A".repeat(11)}…`, "long errors are truncated with an ellipsis");

  const failedMessages = [
    message({ id: "user-old", role: "user", turnId: "turn-old", content: "Earlier" }),
    message({ id: "assistant-old", role: "assistant", turnId: "turn-old", content: "Done" }),
    message({ id: "user-failed", role: "user", turnId: "turn-failed", content: "Try this" }),
    message({
      id: "assistant-failed",
      role: "assistant",
      status: "error",
      turnId: "turn-failed",
      content: "Partial",
      toolCalls: [{ id: "call-1", name: "shell", status: "done" }],
    }),
    message({
      id: "tool-failed",
      role: "tool",
      status: "error",
      toolCallId: "call-1",
      turnId: "turn-failed",
      content: "failed",
    }),
  ];
  const prepared = prepareFailedTurnRetryTranscript(failedMessages, "turn-failed");
  assert(prepared, "failed turn with a user anchor is retryable");
  assert(
    JSON.stringify(prepared.keepTurnIds) === JSON.stringify(["turn-old"]),
    "durable keep ids exclude the failed turn",
  );
  assert(
    prepared.messages.map((entry) => entry.id).join(",") ===
      "user-old,assistant-old,user-failed",
    "failed assistant and tool records are removed without duplicating the user",
  );
  assert(prepared.userMessage.isStored === false, "retained user is marked for reinsertion");

  const session: Session = {
    compactedContext: {
      compactedTurnIds: ["turn-old", "turn-failed"],
      summary: "summary",
      tokens: 10,
      updatedAtMs: 1,
    },
    events: [
      {
        afterMessageCount: 1,
        createdAtMs: 1,
        id: "event-kept",
        phase: "compacted",
        type: "context_status",
        updatedAtMs: 1,
      },
      {
        afterMessageCount: 99,
        createdAtMs: 2,
        id: "event-after-suffix",
        phase: "compacted",
        type: "context_status",
        updatedAtMs: 2,
      },
      {
        afterMessageCount: 1,
        createdAtMs: 3,
        id: "event-still-compacting",
        phase: "compacting",
        type: "context_status",
        updatedAtMs: 3,
      },
    ],
    id: "session-1",
    messages: failedMessages,
    messagesLoaded: true,
    replayTurnSummaries: [
      {
        completedAtMs: 1,
        estimatedTokensImageCapable: 1,
        estimatedTokensTextOnly: 1,
        estimatorVersion: 1,
        messageIds: ["user-old", "assistant-old"],
        replayMessageCountImageCapable: 2,
        replayMessageCountTextOnly: 2,
        turnId: "turn-old",
      },
      {
        completedAtMs: 2,
        estimatedTokensImageCapable: 1,
        estimatedTokensTextOnly: 1,
        estimatorVersion: 1,
        messageIds: ["user-failed", "assistant-failed"],
        replayMessageCountImageCapable: 2,
        replayMessageCountTextOnly: 2,
        turnId: "turn-failed",
      },
    ],
    title: "Test",
    updatedAtLabel: "earlier",
  };
  applyFailedTurnRetryTranscript(
    session,
    prepared,
    { modelId: "model-new", reasoningLevel: "" },
  );
  assert(session.messages.length === 3, "session receives the truncated transcript");
  assert(
    session.replayTurnSummaries?.map((summary) => summary.turnId).join(",") === "turn-old",
    "failed-turn replay summaries are removed",
  );
  assert(
    session.compactedContext?.compactedTurnIds.join(",") === "turn-old",
    "compacted turn ids are intersected with durable retained turns",
  );
  assert(
    session.events?.map((event) => event.id).join(",") === "event-kept",
    "stale and still-compacting context events are removed",
  );
  assert(session.modelId === "model-new", "retry selection is applied with the transcript");

  const recoverableSession: Session = {
    id: "session-recover",
    messagesLoaded: true,
    selectedModelUuid: "model-selected-later",
    title: "Recover",
    updatedAtLabel: "now",
    messages: [
      message({ id: "recover-user", role: "user", turnId: "turn-recover" }),
      message({
        id: "recover-assistant",
        role: "assistant",
        status: "done",
        turnId: "turn-recover",
        content: "Partial answer",
        parts: [
          {
            content: "Partial answer",
            id: "recover-content",
            metadata: {
              wizzleFailedTurn: {
                error: "Provider failed.",
                hadPartialContent: true,
                modelId: "model-that-failed",
                turnId: "turn-recover",
              },
            },
            status: "done",
            type: "content",
          },
        ],
      }),
    ],
  };
  const recovered = recoverSessionStreamError(recoverableSession);
  assert(recovered?.modelId === "model-that-failed", "durable marker restores failed model");
  assert(recovered?.hadPartialContent === true, "durable marker restores partial state");
  assert(
    recovered?.message.includes("Partial content is kept above."),
    "recovered error retains partial-content guidance",
  );

  const staleMarkerSession: Session = {
    ...recoverableSession,
    messages: recoverableSession.messages.map((entry) =>
      entry.role === "assistant"
        ? {
            ...entry,
            parts: entry.parts?.map((part) => ({
              ...part,
              metadata: {
                wizzleFailedTurn: {
                  error: "Stale failure",
                  hadPartialContent: false,
                  modelId: "model-old",
                  turnId: "turn-other",
                },
              },
            })),
          }
        : entry,
    ),
  };
  assert(
    recoverSessionStreamError(staleMarkerSession) === null,
    "marker for a different turn cannot create a detached retry panel",
  );

  const completedAfterFailure: Session = {
    ...recoverableSession,
    messages: [
      ...recoverableSession.messages,
      message({ id: "later-user", role: "user", turnId: "turn-later" }),
      message({ id: "later-assistant", role: "assistant", turnId: "turn-later" }),
    ],
  };
  assert(
    recoverSessionStreamError(completedAfterFailure) === null,
    "a later successful turn suppresses stale failure recovery",
  );
}

main();
console.log("failed turn recovery tests passed");
