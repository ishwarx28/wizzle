(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {
  WIZZLE_FRONTEND_LOG_MODE: "off",
  WIZZLE_FRONTEND_LOG_RETENTION_DAYS: "7",
};

export {};

const [{ createSubagentResponseMessage }, { buildChatMessages }] = await Promise.all([
  import("./message-factories.ts"),
  import("../chat-stream.ts"),
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const response = createSubagentResponseMessage(
    {
      completedAtMs: 100,
      join: "required",
      name: "explorer",
      output: "Found the agent runner.",
      ownerTurnId: "turn-origin",
      recipientTaskId: null,
      sequence: 1,
      status: "completed",
      task: "Locate the runner",
      taskId: "subagent-123",
    },
    "turn-1",
  );
  const replay = buildChatMessages([response], new Map(), ["text"]);

  assert(response.parts?.[0]?.type === "subagent_response", "UI receives a response part");
  assert(response.turnId === "turn-origin", "response remains attached to its originating turn");
  assert(replay.length === 1 && replay[0]?.role === "system", "response is injected as system context");
  assert(
    typeof replay[0]?.content === "string" && replay[0].content.includes("subagent-123"),
    "injection includes the originating task ID",
  );
  assert(
    typeof replay[0]?.content === "string" && replay[0].content.includes("Found the agent runner."),
    "injection includes the completed findings",
  );
  const replayFromParts = buildChatMessages(
    [{ ...response, content: "" }],
    new Map(),
    ["text"],
  );
  assert(
    typeof replayFromParts[0]?.content === "string" &&
      replayFromParts[0].content.includes("subagent-123") &&
      replayFromParts[0].content.includes("Found the agent runner."),
    "response replay falls back to the persisted response part",
  );

  const interrupted = createSubagentResponseMessage(
    {
      completedAtMs: 200,
      join: "required",
      name: "worker",
      output: "The worker subagent was interrupted manually by the user.",
      ownerTurnId: "turn-2",
      recipientTaskId: null,
      sequence: 1,
      status: "interrupted",
      task: "Implement the change",
      taskId: "subagent-456",
      trigger: "manual",
    },
    "fallback-turn",
  );
  assert(interrupted.status === "interrupted", "manual interruption remains interrupted in UI");
  assert(
    interrupted.parts?.[0]?.metadata?.trigger === "manual",
    "manual interruption metadata is available to the expandable response UI",
  );

  console.log("subagent-response tests passed");
}

main();
