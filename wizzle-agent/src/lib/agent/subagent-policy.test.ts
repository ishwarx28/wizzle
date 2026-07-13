import systemPrompt from "../prompts/system-prompt.txt?raw";
import explorerPrompt from "../prompts/subagents/explorer-system-prompt.txt?raw";
import reviewerPrompt from "../prompts/subagents/reviewer-system-prompt.txt?raw";
import workerPrompt from "../prompts/subagents/worker-system-prompt.txt?raw";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  assert(systemPrompt.includes("user never needs to request delegation"), "delegation is proactive");
  assert(systemPrompt.includes("Broad codebase discovery requires Explorer"), "broad exploration must delegate");
  assert(systemPrompt.toLowerCase().includes("wait again unless"), "timed-out joins do not duplicate work");
  assert(systemPrompt.includes("other clearly separate useful work"), "parallel work is collaborative");
  assert(systemPrompt.includes("Wait ends immediately"), "long waits wake on completion");
  assert(systemPrompt.includes("Never give up"), "slow tools are not abandoned");
  assert(systemPrompt.includes("tool-backed objective"), "general tool failures remain retryable");
  assert(explorerPrompt.includes("strictly read-only"), "Explorer cannot mutate");
  assert(reviewerPrompt.includes("strictly read-only"), "Reviewer cannot mutate");
  assert(workerPrompt.includes("only files necessary"), "Worker stays within its task");
  console.log("subagent-policy tests passed");
}

main();
