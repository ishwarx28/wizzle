import type { ToolExecutionPayload } from "../message-factories";
import { TodoEngine } from "./engine";
import type { TodoToolInput } from "./types";

export function runTodoTool(engine: TodoEngine, argumentsJson: string): ToolExecutionPayload {
  try {
    const input = JSON.parse(argumentsJson || "{}") as TodoToolInput;
    const result = engine.run(input);
    return { error: null, output: JSON.stringify(result), status: "done" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The TODO tool failed.";
    return { error: message, output: JSON.stringify({ error: message, ok: false }), status: "error" };
  }
}
