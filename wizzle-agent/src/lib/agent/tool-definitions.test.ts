import {
  SHELL_TOOL,
  CLARIFY_TOOL,
  IMPLEMENTATION_PLAN_TOOL,
  resolveAgentTools,
  SUBAGENT_TOOL,
  TOOL_SCHEMA_VERSION,
} from "./tool-definitions.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(TOOL_SCHEMA_VERSION === 26, "subagent join description schema bump");
  assert(SHELL_TOOL.name === "shell", "host command tool uses the platform-neutral shell name");
  assert(
    SHELL_TOOL.description.includes("cmd.exe /C") && SHELL_TOOL.description.includes("sh -lc"),
    "shell tool describes both supported host command shells",
  );
  assert(
    SHELL_TOOL.description.includes("automatic verification report"),
    "shell tool tells the agent to inspect automatic diagnostics",
  );
  const shellProperties = SHELL_TOOL.parameters.properties as Record<string, { description?: string; enum?: string[] }>;
  assert(
    Boolean(shellProperties.description?.description),
    "shell tool exposes a user-facing description argument",
  );
  assert(
    shellProperties.type?.enum?.join(",") === "foreground,background",
    "shell requires an explicit foreground/background type",
  );
  assert(
    (SHELL_TOOL.parameters.required as string[]).includes("type"),
    "shell execution type is required",
  );
  assert(
    !("background" in shellProperties),
    "shell no longer exposes the ignorable optional background boolean",
  );
  const readTool = resolveAgentTools().find((tool) => tool.function.name === "read");
  const readProperties = readTool?.function.parameters.properties as
    | Record<string, { default?: unknown; maximum?: unknown }>
    | undefined;
  assert(readProperties?.limit?.default === 400, "read defaults to a 400-line page");
  assert(readProperties?.limit?.maximum === 2000, "read retains the explicit 2000-line cap");
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
  assert(
    IMPLEMENTATION_PLAN_TOOL.name === "implementation_plan",
    "implementation planner has the expected name",
  );
  const planProperties = IMPLEMENTATION_PLAN_TOOL.parameters.properties as Record<
    string,
    { enum?: unknown[] }
  >;
  assert(
    planProperties.action?.enum?.join(",") === "save,advance",
    "planner exposes only save and advance",
  );
  assert(Boolean(planProperties.markdown), "planner accepts one compact Markdown document");
  assert(Object.keys(planProperties).length === 2, "planner has no model-facing workflow IDs or nested plan fields");
  assert(CLARIFY_TOOL.name === "clarify", "clarify tool has the expected name");
  const clarifyProperties = CLARIFY_TOOL.parameters.properties as Record<string, unknown>;
  assert(
    Boolean(clarifyProperties.allowCustomAnswer),
    "clarify distinguishes selection-only and mixed questions",
  );
  assert(
    resolveAgentTools().some((tool) => tool.function.name === "implementation_plan") &&
      resolveAgentTools().some((tool) => tool.function.name === "clarify"),
    "main agents receive implementation planner and clarify tools",
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
