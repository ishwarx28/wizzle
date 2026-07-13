import { buildSubagentTaskPrompt } from "./subagent-prompt.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const prompt = buildSubagentTaskPrompt({
    isContinuation: false,
    parentRequest: "Do not read /planning. Inspect only.",
    task: "Locate the replay builder.",
  });
  assert(prompt.includes("Do not read /planning"), "parent constraints reach the subagent");
  assert(prompt.includes("Locate the replay builder"), "delegated task remains explicit");

  const continuation = buildSubagentTaskPrompt({
    isContinuation: true,
    parentRequest: "Inspect only.",
    task: "Check one more caller.",
  });
  assert(
    continuation.includes("self-contained consolidated result"),
    "continuations cannot emit context-dependent duplicate replies",
  );

  console.log("subagent-prompt tests passed");
}

main();
