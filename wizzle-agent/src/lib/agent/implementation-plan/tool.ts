import type { ToolExecutionPayload } from "../message-factories";
import type { ImplementationPlanEngine } from "./engine";
import type { ImplementationPlanToolInput } from "./types";

export function runImplementationPlanTool(
  engine: ImplementationPlanEngine,
  argumentsJson: string,
): ToolExecutionPayload {
  try {
    const input = JSON.parse(argumentsJson || "{}") as ImplementationPlanToolInput;
    const output = engine.run(input);
    return { error: null, output: JSON.stringify(output), status: "done" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The implementation planner failed.";
    return {
      error: message,
      output: JSON.stringify({ error: message, ok: false, stopTurn: false }),
      status: "error",
    };
  }
}
