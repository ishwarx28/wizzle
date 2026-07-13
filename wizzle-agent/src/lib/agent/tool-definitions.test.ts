import {
  BASH_TOOL,
  CLARIFY_TOOL,
  resolveAgentTools,
  SUBAGENT_TOOL,
  TODO_TOOL,
  TOOL_SCHEMA_VERSION,
} from "./tool-definitions.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(TOOL_SCHEMA_VERSION === 14, "clarify answer-mode schema bump");
  const bashProperties = BASH_TOOL.parameters.properties as Record<string, { description?: string }>;
  assert(
    Boolean(bashProperties.description?.description),
    "bash tool exposes a user-facing description argument",
  );
  assert(SUBAGENT_TOOL.name === "subagent", "subagent tool has the expected name");
  assert(
    SUBAGENT_TOOL.description.toLowerCase().includes("completion"),
    "tool description explains completion-driven waits",
  );
  const properties = SUBAGENT_TOOL.parameters.properties as Record<string, { description?: string; enum?: unknown[] }>;
  assert(
    Object.keys(properties).sort().join(",") === "action,join,name,prompt,taskId,timeoutMs",
    "subagent tool exposes only the simplified parameters",
  );
  assert(
    properties.timeoutMs?.enum?.join(",") === "30s,1m,2m,5m,10m",
    "subagent timeout uses the supported duration enum",
  );
  assert(
    properties.timeoutMs?.description?.includes("only when action is wait"),
    "subagent timeout is documented as wait-only",
  );
  assert(
    resolveAgentTools().some((tool) => tool.function.name === "subagent"),
    "main agents receive the subagent tool",
  );
  assert(TODO_TOOL.name === "todo", "TODO tool has the expected name");
  const todoProperties = TODO_TOOL.parameters.properties as Record<string, { enum?: unknown[] }>;
  assert(
    todoProperties.action?.enum?.join(",") === "create,add,update,status,clear",
    "TODO exposes the compact session-list actions",
  );
  assert(Boolean(todoProperties.type), "TODO accepts a task type for library enrichment");
  assert(Boolean(todoProperties.items), "TODO accepts the initial model-authored items");
  assert(CLARIFY_TOOL.name === "clarify", "clarify tool has the expected name");
  const clarifyProperties = CLARIFY_TOOL.parameters.properties as Record<string, unknown>;
  assert(
    Boolean(clarifyProperties.allowCustomAnswer),
    "clarify distinguishes selection-only and mixed questions",
  );
  assert(
    resolveAgentTools().some((tool) => tool.function.name === "todo") &&
      resolveAgentTools().some((tool) => tool.function.name === "clarify"),
    "main agents receive TODO and clarify tools",
  );
  assert(
    !resolveAgentTools({ includeSubagent: false }).some(
      (tool) => tool.function.name === "subagent",
    ),
    "hidden subagents cannot recursively create subagents",
  );

  console.log("tool-definitions tests passed");
}

main();
