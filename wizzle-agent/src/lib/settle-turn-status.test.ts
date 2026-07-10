import {
  settleAssistantMessageFields,
  settleUserMessageFields,
  settleNonToolTurnMessage,
} from "./settle-turn-status.ts";
import type { Message } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function baseUser(overrides: Partial<Message> = {}): Message {
  return {
    content: "hello",
    createdAtLabel: "now",
    createdAtMs: 1,
    id: "message-user-1",
    role: "user",
    status: "done",
    toolCalls: [],
    toolResults: [],
    turnId: "turn-1",
    ...overrides,
  };
}

function baseAssistant(overrides: Partial<Message> = {}): Message {
  return {
    assistantPhase: "working",
    content: "ok",
    createdAtLabel: "now",
    createdAtMs: 1,
    id: "message-assistant-1",
    parts: [
      {
        content: "ok",
        createdAtMs: 1,
        id: "p1",
        status: "done",
        type: "content",
      },
    ],
    role: "assistant",
    startedAtMs: 1,
    status: "done",
    toolCalls: [],
    toolResults: [],
    turnId: "turn-1",
    ...overrides,
  };
}

function testUserKeepsDoneAndDropsAssistantPhase() {
  const user = baseUser({
    assistantPhase: "final",
    status: "error",
  });

  settleUserMessageFields(user);
  assert(user.status === "done", "user status must stay successful");
  assert(user.assistantPhase === undefined, "user must not keep assistantPhase");
}

function testCompletedAssistantNotRewrittenOnTurnError() {
  const assistant = baseAssistant({ status: "done", assistantPhase: "working" });
  settleAssistantMessageFields(assistant, "error", 100);
  assert(assistant.status === "done", "completed assistant stays done on turn error");
  assert(assistant.assistantPhase === "working", "phase preserved");
  assert(assistant.parts?.[0]?.status === "done", "done parts stay done");
}

function testStreamingAssistantInheritsTurnError() {
  const assistant = baseAssistant({
    status: "streaming",
    assistantPhase: undefined,
    parts: [
      {
        content: "partial",
        createdAtMs: 1,
        id: "p1",
        status: "streaming",
        type: "content",
      },
    ],
  });
  settleAssistantMessageFields(assistant, "error", 100);
  assert(assistant.status === "error", "incomplete assistant becomes error");
  assert(assistant.assistantPhase === "final", "phase set for assistant only");
  assert(assistant.parts?.[0]?.status === "error", "streaming part becomes error");
}

function testNonToolRouter() {
  const user = baseUser({ assistantPhase: "final", status: "interrupted" });
  settleNonToolTurnMessage(user, "interrupted", 50);
  assert(user.status === "done", "user not interrupted");
  assert(user.assistantPhase === undefined, "no phase on user");

  const assistant = baseAssistant({ status: "streaming", assistantPhase: undefined });
  settleNonToolTurnMessage(assistant, "interrupted", 50);
  assert(assistant.status === "interrupted", "streaming assistant interrupted");
}

async function main() {
  testUserKeepsDoneAndDropsAssistantPhase();
  testCompletedAssistantNotRewrittenOnTurnError();
  testStreamingAssistantInheritsTurnError();
  testNonToolRouter();
  console.log("settle-turn-status tests passed");
}

main().catch((error) => {
  console.error(error);
  throw error;
});
