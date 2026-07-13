import { runClarifyTool } from "./clarify-tool.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const result = await runClarifyTool({
    argumentsJson: JSON.stringify({
      allowCustomAnswer: false,
      choices: ["Web", "Desktop"],
      kind: "approach",
      prompt: "Which target should I use?",
      recommended: 0,
    }),
    request: async (request) => {
      assert(request.kind === "approach", "the blocking request preserves its kind");
      assert(request.allowCustomAnswer === false, "selection-only mode reaches the prompt");
      return "Web";
    },
  });
  assert(
    result.status === "done" && result.output?.includes('"answer":"Web"'),
    "the answer returns to the same tool call",
  );

  const invalid = await runClarifyTool({
    argumentsJson: JSON.stringify({ kind: "doubt", prompt: "", choices: ["Only one"] }),
    request: async () => "unused",
  });
  assert(invalid.status === "error", "invalid clarification calls return a meaningful tool error");

  console.log("clarify tool tests passed");
}

void main();
