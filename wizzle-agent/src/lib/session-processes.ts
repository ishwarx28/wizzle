import type { WorkspaceProcess } from "../types/workspace";

export type SessionProcessView = {
  commandSummary: string;
  id: string;
  isActive: boolean;
  status: string;
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
  };
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
