import type { ToolExecutionPayload } from "./message-factories";

export type ClarifyKind = "approach" | "doubt";

export type ClarifyRequest = {
  allowCustomAnswer?: boolean;
  choices?: string[];
  kind: ClarifyKind;
  prompt: string;
  recommended?: number;
  sessionId: string;
  toolCallId: string;
};

function parse(argumentsJson: string): Omit<ClarifyRequest, "sessionId" | "toolCallId"> {
  const input = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
  if (input.kind !== "doubt" && input.kind !== "approach") {
    throw new Error("Clarify kind must be doubt or approach.");
  }
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new Error("Clarify prompt requires meaningful text.");
  }
  if (input.choices !== undefined && (!Array.isArray(input.choices) || input.choices.length < 2 || input.choices.length > 3 || input.choices.some((choice) => typeof choice !== "string" || !choice.trim()))) {
    throw new Error("Clarify choices must contain two or three meaningful values.");
  }
  if (input.recommended !== undefined) {
    if (!Array.isArray(input.choices) || !Number.isInteger(input.recommended) || Number(input.recommended) < 0 || Number(input.recommended) >= input.choices.length) {
      throw new Error("Clarify recommended must be a valid zero-based choices index.");
    }
  }
  if (input.allowCustomAnswer !== undefined && typeof input.allowCustomAnswer !== "boolean") {
    throw new Error("Clarify allowCustomAnswer must be true or false.");
  }
  return {
    allowCustomAnswer: input.allowCustomAnswer as boolean | undefined,
    choices: input.choices as string[] | undefined,
    kind: input.kind,
    prompt: input.prompt.trim(),
    recommended: input.recommended as number | undefined,
  };
}

export async function runClarifyTool(options: {
  argumentsJson: string;
  request: (request: Omit<ClarifyRequest, "sessionId" | "toolCallId">) => Promise<string>;
}): Promise<ToolExecutionPayload> {
  try {
    const input = parse(options.argumentsJson);
    const answer = await options.request(input);
    return { error: null, output: JSON.stringify({ answer, ok: true }), status: "done" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clarification failed.";
    return { error: message, output: JSON.stringify({ error: message, ok: false }), status: "error" };
  }
}
