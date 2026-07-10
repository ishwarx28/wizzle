import type { WorkspaceProcess } from "../types/workspace";

export type SessionProcessView = {
  commandSummary: string;
  id: string;
  isActive: boolean;
  status: string;
  toolCallId?: string | null;
  turnId?: string | null;
};

export function isActiveProcessStatus(status: string | undefined) {
  const normalized = (status ?? "").toLowerCase();
  return normalized === "running" || normalized === "pending";
}

export function summarizeProcessCommand(command: string) {
  const trimmed = command.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 72) {
    return trimmed || "Background process";
  }

  return `${trimmed.slice(0, 69).trimEnd()}…`;
}

export function toSessionProcessView(process: WorkspaceProcess): SessionProcessView {
  return {
    commandSummary: summarizeProcessCommand(process.command),
    id: process.id,
    isActive: isActiveProcessStatus(process.status),
    status: process.status,
    toolCallId: process.toolCallId ?? null,
    turnId: process.turnId ?? null,
  };
}

/** Short label for process panel (avoid dumping full UUIDs). */
export function formatProcessOriginLabel(process: {
  toolCallId?: string | null;
  turnId?: string | null;
}) {
  const turn = process.turnId?.trim();
  const tool = process.toolCallId?.trim();
  if (!turn && !tool) {
    return null;
  }

  const shortTurn = turn
    ? turn.length > 14
      ? `${turn.slice(0, 8)}…`
      : turn
    : null;
  const shortTool = tool
    ? tool.length > 16
      ? `${tool.slice(0, 10)}…`
      : tool
    : null;

  if (shortTurn && shortTool) {
    return `${shortTurn} · ${shortTool}`;
  }
  return shortTurn ?? shortTool;
}

export function selectActiveSessionProcesses(processes: WorkspaceProcess[]) {
  return processes
    .filter((process) => isActiveProcessStatus(process.status))
    .map(toSessionProcessView);
}

export function upsertProcessList(
  processes: WorkspaceProcess[],
  next: WorkspaceProcess,
): WorkspaceProcess[] {
  const index = processes.findIndex((entry) => entry.id === next.id);
  if (index < 0) {
    return [...processes, next];
  }

  const copy = [...processes];
  copy[index] = next;
  return copy;
}

export function filterProcessesForSession(
  processes: WorkspaceProcess[],
  sessionId: string | null | undefined,
) {
  if (!sessionId) {
    return [];
  }

  return processes.filter((process) => process.sessionId === sessionId);
}

/** Bash tool result is a background spawn when payload.background is true. */
export function isBackgroundBashPayload(payload: {
  background?: boolean;
  process?: { id?: string } | null;
} | null) {
  if (!payload) {
    return false;
  }

  return payload.background === true || Boolean(payload.process?.id);
}

export function resolveBackgroundProcessId(payload: {
  process?: { id?: string } | null;
} | null) {
  const id = payload?.process?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}
