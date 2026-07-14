import { invoke } from "@tauri-apps/api/core";

import type { ToolExecutionPayload } from "./agent/message-factories";
import {
  collectToolPathCandidates,
  createExternalPathWarning,
  isWhitelistedBashCommand,
  type ResolvedPathCandidate,
} from "./tool-path-risk";
import { DEFAULT_TOOL_TIMEOUT } from "./agent/tool-timeouts";
import type { ToolTimeoutOption } from "./agent/tool-timeouts";
import type { PermissionMode, ToolApprovalRequest } from "../types/workspace";

type ApprovalToolName = ToolApprovalRequest["toolName"];

type ToolArgumentPayload = {
  command?: string;
  cwd?: string;
  description?: string;
  path?: string;
  timeout?: ToolTimeoutOption;
};

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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

async function resolveToolPathCandidates(input: {
  candidates: string[];
  cwd?: string;
  projectRoot: string;
}): Promise<ResolvedPathCandidate[] | undefined> {
  if (input.candidates.length === 0) {
    return [];
  }

  if (!isTauriRuntime()) {
    return undefined;
  }

  try {
    return await invoke<ResolvedPathCandidate[]>("resolve_tool_path_candidates", {
      input: {
        candidates: input.candidates,
        cwd: input.cwd ?? null,
        projectRoot: input.projectRoot,
      },
    });
  } catch (error) {
    return input.candidates.map((candidate) => ({
      error: error instanceof Error ? error.message : String(error),
      hasUnexpandedVariables: true,
      rawPath: candidate,
    }));
  }
}

export async function createToolApprovalRequest(input: {
  arguments: string;
  permissionMode: PermissionMode;
  projectRoot: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
}): Promise<ToolApprovalRequest | null> {
  if (!["bash", "edit", "read", "write"].includes(input.toolName)) {
    return null;
  }

  const toolName = input.toolName as ApprovalToolName;
  const payload = parseArguments(input.arguments);
  const command = toolName === "bash" ? payload.command?.trim() : undefined;
  const description = toolName === "bash" ? payload.description?.trim() || undefined : undefined;
  const path = toolName !== "bash" ? payload.path?.trim() : undefined;
  const cwd = toolName === "bash" ? payload.cwd?.trim() : undefined;
  const pathCandidates = collectToolPathCandidates({
    command,
    path,
    toolName,
  });
  const [resolvedPaths, resolvedCwdEntries] = await Promise.all([
    resolveToolPathCandidates({
      candidates: pathCandidates,
      cwd,
      projectRoot: input.projectRoot,
    }),
    resolveToolPathCandidates({
      candidates: cwd ? [cwd] : [],
      projectRoot: input.projectRoot,
    }),
  ]);
  const warning = createExternalPathWarning({
    command,
    cwd,
    path,
    permissionMode: input.permissionMode,
    projectRoot: input.projectRoot,
    resolvedCwd: resolvedCwdEntries?.[0],
    resolvedPaths,
    toolName,
  });

  const canRunWithoutApproval =
    (toolName === "bash" && input.permissionMode === "full-access") ||
    (!warning &&
      ((toolName === "bash" && isWhitelistedBashCommand(command ?? "")) ||
        (toolName !== "bash" &&
          (input.permissionMode === "full-access" || toolName === "read"))));

  if (canRunWithoutApproval) {
    return null;
  }

  return {
    arguments: input.arguments,
    command,
    description,
    path,
    sessionId: input.sessionId,
    summary: summarizeRequest(toolName, payload),
    timeout: payload.timeout ?? DEFAULT_TOOL_TIMEOUT,
    toolCallId: input.toolCallId,
    toolName,
    warning,
  };
}

export function createToolApprovalBatchRequest(requests: ToolApprovalRequest[]) {
  const firstRequest = requests[0];

  if (!firstRequest) {
    throw new Error("A tool approval batch requires at least one request.");
  }

  if (requests.some((request) => request.sessionId !== firstRequest.sessionId)) {
    throw new Error("A tool approval batch cannot span multiple sessions.");
  }

  if (requests.length === 1) {
    return firstRequest;
  }

  return {
    ...firstRequest,
    batchRequests: requests,
    summary: `Wizzle wants to run ${requests.length} tool calls.`,
  };
}

export function createRejectedToolPayload(request: ToolApprovalRequest): ToolExecutionPayload {
  return {
    error: "The user rejected this tool request.",
    output: JSON.stringify({
      command: request.command,
      error: "The user rejected this tool request.",
      ok: false,
      path: request.path,
      rejected: true,
      timeout: request.timeout,
    }),
    // Not "done" — rejection must not look like a successful tool run (#39).
    status: "error",
  };
}
