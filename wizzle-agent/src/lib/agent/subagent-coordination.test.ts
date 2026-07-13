import { buildSubagentCoordinationMessage } from "./subagent-coordination.ts";
import type { SubagentSnapshot } from "./subagent-manager.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const task = (overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot => ({
  activeOwnerTurnId: "turn-1",
  completedAtMs: null,
  createdAtMs: 1,
  interruptedAtMs: null,
  join: "required",
  latestOutput: null,
  name: "explorer",
  ownerTaskId: null,
  pendingMessageCount: 0,
  status: "working",
  task: "trace replay history",
  taskId: "subagent-1",
  updatedAtMs: 1,
  ...overrides,
});

function main() {
  const message = buildSubagentCoordinationMessage([task()]);
  assert(message.includes("Never duplicate"), "live guidance prevents duplicate work");
  assert(message.includes("clearly separate work"), "live guidance permits collaboration");
  assert(message.includes("wait again"), "live guidance treats timeout as non-terminal");
  assert(message.includes("subagent-1"), "live guidance preserves task identity");
  console.log("subagent-coordination tests passed");
}

main();
