import {
  filterProcessesForSession,
  isActiveProcessStatus,
  isBackgroundBashPayload,
  resolveBackgroundProcessId,
  selectActiveSessionProcesses,
  summarizeProcessCommand,
  upsertProcessList,
} from "./session-processes.ts";
import type { WorkspaceProcess } from "../types/workspace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function process(overrides: Partial<WorkspaceProcess> = {}): WorkspaceProcess {
  return {
    command: "npm run dev",
    cwd: "/tmp",
    id: "process-1",
    sessionId: "session-a",
    startedAtMs: 1,
    status: "running",
    stderrTail: "",
    stdoutTail: "",
    ...overrides,
  };
}

function main() {
  assert(isActiveProcessStatus("running"), "running active");
  assert(isActiveProcessStatus("pending"), "pending active");
  assert(!isActiveProcessStatus("done"), "done inactive");
  assert(!isActiveProcessStatus("interrupted"), "interrupted inactive");

  assert(summarizeProcessCommand("echo hi") === "echo hi", "short command");
  assert(summarizeProcessCommand("a".repeat(80)).endsWith("…"), "long command truncated");

  const active = selectActiveSessionProcesses([
    process({ id: "p1", status: "running" }),
    process({ id: "p2", status: "done" }),
  ]);
  assert(active.length === 1 && active[0]?.id === "p1", "only active listed");

  const updated = upsertProcessList(
    [process({ id: "p1", status: "running" })],
    process({ id: "p1", status: "interrupted" }),
  );
  assert(updated[0]?.status === "interrupted", "upsert updates");

  assert(
    filterProcessesForSession(
      [process({ sessionId: "a" }), process({ id: "p2", sessionId: "b" })],
      "a",
    ).length === 1,
    "filter by session",
  );

  assert(isBackgroundBashPayload({ background: true }), "background flag");
  assert(isBackgroundBashPayload({ process: { id: "process-x" } }), "process id");
  assert(!isBackgroundBashPayload({ ok: true } as { background?: boolean }), "foreground");
  assert(resolveBackgroundProcessId({ process: { id: " process-x " } }) === "process-x", "id trim");

  console.log("session-processes tests passed");
}

main();
