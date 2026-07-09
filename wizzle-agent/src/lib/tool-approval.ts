import type { ToolExecutionPayload } from "./agent/message-factories";
import { createExternalPathWarning } from "./tool-path-risk";
import { DEFAULT_TOOL_TIMEOUT } from "./agent/tool-timeouts";
import type { ToolTimeoutOption } from "./agent/tool-timeouts";
import type { PermissionMode, ToolApprovalRequest } from "../types/workspace";

type ApprovalToolName = ToolApprovalRequest["toolName"];

type ToolArgumentPayload = {
  command?: string;
  path?: string;
  timeout?: ToolTimeoutOption;
};

function parseArguments(argumentsText: string): ToolArgumentPayload {
  if (!argumentsText.trim()) {
    return {};
  }

  try {
    return JSON.parse(argumentsText) as ToolArgumentPayload;
  } catch {
    return {};
  }
}

function summarizeRequest(toolName: ApprovalToolName, payload: ToolArgumentPayload) {
  if (toolName === "bash") {
    return "Wizzle wants to run a command.";
  }

  if (toolName === "read") {
    return `Wizzle wants to read ${payload.path ?? "a file"}.`;
  }

  if (toolName === "write") {
    return `Wizzle wants to create or replace ${payload.path ?? "a file"}.`;
  }

  return `Wizzle wants to edit ${payload.path ?? "a file"}.`;
}

export function createToolApprovalRequest(input: {
  arguments: string;
  globalSkillsDir?: string;
  permissionMode: PermissionMode;
  projectRoot: string;
  toolCallId: string;
  toolName: string;
}): ToolApprovalRequest | null {
  if (!["bash", "edit", "read", "write"].includes(input.toolName)) {
    return null;
  }

  const toolName = input.toolName as ApprovalToolName;
  const payload = parseArguments(input.arguments);
  const warning = createExternalPathWarning({
    command: toolName === "bash" ? payload.command?.trim() : undefined,
    globalSkillsDir: input.globalSkillsDir,
    path: toolName !== "bash" ? payload.path?.trim() : undefined,
    permissionMode: input.permissionMode,
    projectRoot: input.projectRoot,
    toolName,
  });

  if (input.permissionMode === "full-access" && !warning) {
    return null;
  }

  return {
    command: toolName === "bash" ? payload.command?.trim() : undefined,
    path: toolName !== "bash" ? payload.path?.trim() : undefined,
    summary: summarizeRequest(toolName, payload),
    timeout: payload.timeout ?? DEFAULT_TOOL_TIMEOUT,
    toolCallId: input.toolCallId,
    toolName,
    warning,
  };
}

export function createRejectedToolPayload(request: ToolApprovalRequest): ToolExecutionPayload {
  return {
    output: JSON.stringify({
      command: request.command,
      error: "The user rejected this tool request.",
      ok: false,
      path: request.path,
      rejected: true,
      timeout: request.timeout,
    }),
    status: "done",
  };
}
