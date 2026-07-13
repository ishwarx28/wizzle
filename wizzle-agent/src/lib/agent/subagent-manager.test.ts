import {
  createSubagentManager,
  type StartSubagentRun,
  type SubagentRunResult,
  withoutSubagentOutput,
} from "./subagent-manager.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function main() {
  const manager = createSubagentManager();
  const runs = new Map<
    string,
    ReturnType<typeof deferred<SubagentRunResult>> & { interrupted: boolean }
  >();
  const start: StartSubagentRun = ({ onUpdate, taskId }) => {
    const run = { ...deferred<SubagentRunResult>(), interrupted: false };
    runs.set(taskId, run);
    onUpdate([]);
    return {
      interrupt: async () => {
        run.interrupted = true;
      },
      promise: run.promise,
    };
  };

  const first = manager.create({
    name: "explorer",
    ownerTurnId: "turn-1",
    prompt: "first",
    sessionId: "session-1",
    start,
  });
  const second = manager.create({
    name: "reviewer",
    ownerTurnId: "turn-1",
    prompt: "second",
    sessionId: "session-1",
    start,
  });
  const thirdWorker = manager.create({
    name: "worker",
    ownerTurnId: "turn-1",
    prompt: "third",
    sessionId: "session-1",
    start,
  });

  const replacement = manager.create({
    name: "worker",
    ownerTurnId: "turn-1",
    prompt: "fourth",
    sessionId: "session-1",
    start,
  });
  assert(replacement.taskId !== thirdWorker.taskId, "same-role create allocates a fresh task ID");
  assert(runs.get(thirdWorker.taskId)?.interrupted, "same-role create interrupts the previous run");
  assert(
    manager.list("session-1").filter((task) => task.name === "worker").length === 1,
    "same-role create deletes the previous entry",
  );
  assert(
    manager.list("session-1").find((task) => task.name === "worker")?.task === "fourth",
    "same-role replacement exposes only the new task",
  );

  runs.get(first.taskId)?.resolve({ history: [], output: "first finding" });
  const waited = await manager.wait("session-1", first.taskId, 1_000);
  assert(!waited.timedOut, "wait resolves when findings are ready");
  assert(waited.snapshot.status === "completed", "completed status is recorded");
  assert(waited.snapshot.latestOutput === "first finding", "latest output is retained");
  assert(waited.snapshot.name === "explorer", "role is retained");
  assert(waited.snapshot.task === "first", "assigned task is retained");

  const responses = manager.drainResponses("session-1");
  assert(responses.length === 1, "one completion is injected once");
  assert(responses[0]?.taskId === first.taskId, "completion includes its task ID");
  assert(responses[0]?.ownerTurnId === "turn-1", "completion retains its owner turn");
  assert(manager.drainResponses("session-1").length === 0, "responses are drained once");

  const reused = manager.sendMessage({
    ownerTurnId: "turn-2",
    prompt: "follow up",
    sessionId: "session-1",
    start,
    taskId: first.taskId,
  });
  assert(reused.taskId === first.taskId, "send_message reuses the stable task ID");
  assert(manager.list("session-1").length === 3, "reuse does not allocate a fourth subagent");

  await manager.interrupt("session-1", second.taskId);
  assert(runs.get(second.taskId)?.interrupted, "interrupt targets the requested subagent");
  assert(
    manager.list("session-1").find((task) => task.taskId === second.taskId)?.status ===
      "interrupted",
    "interrupted subagents remain listable",
  );

  const third = manager.list("session-1").find((task) => task.name === "worker")!;
  manager.setWaitingForPermission("session-1", third.taskId, true);
  assert(
    manager.list("session-1").find((task) => task.taskId === third.taskId)?.status ===
      "waiting_permission",
    "permission waits are visible in task status",
  );
  await manager.interruptManually("session-1", third.taskId);
  const manualEvent = manager.drainResponses("session-1").find(
    (response) => response.taskId === third.taskId,
  );
  assert(manualEvent?.trigger === "manual", "manual interruption queues an injected event");

  await manager.interruptTurn("session-1", "turn-2");
  assert(runs.get(first.taskId)?.interrupted, "turn cleanup interrupts reused active work");
  assert(manager.list("session-1").length === 3, "turn cleanup never deletes subagents");

  const continuationManager = createSubagentManager();
  const continuationRuns: Array<ReturnType<typeof deferred<SubagentRunResult>>> = [];
  const continuationStart: StartSubagentRun = () => {
    const run = deferred<SubagentRunResult>();
    continuationRuns.push(run);
    return { interrupt: async () => undefined, promise: run.promise };
  };
  const continued = continuationManager.create({
    name: "explorer",
    ownerTurnId: "turn-continuation",
    prompt: "initial task",
    sessionId: "session-continuation",
    start: continuationStart,
  });
  continuationManager.sendMessage({
    ownerTurnId: "turn-continuation",
    prompt: "substantive follow-up",
    sessionId: "session-continuation",
    start: continuationStart,
    taskId: continued.taskId,
  });
  continuationRuns[0]!.resolve({ history: [], output: "intermediate response" });
  await Promise.resolve();
  await Promise.resolve();
  assert(
    continuationManager.drainResponses("session-continuation").length === 0,
    "queued continuation suppresses the intermediate response injection",
  );
  continuationRuns[1]!.resolve({ history: [], output: "consolidated response" });
  await continuationManager.wait("session-continuation", continued.taskId, 1_000);
  const consolidated = continuationManager.drainResponses("session-continuation");
  assert(consolidated.length === 1, "queued work injects exactly one consolidated response");
  assert(consolidated[0]?.sequence === 1, "suppressed intermediate work does not advance sequence");
  assert(consolidated[0]?.output === "consolidated response", "final continuation output is injected");

  const routingManager = createSubagentManager();
  const routingRuns = new Map<string, ReturnType<typeof deferred<SubagentRunResult>>>();
  const routingStart: StartSubagentRun = ({ taskId }) => {
    const run = deferred<SubagentRunResult>();
    routingRuns.set(taskId, run);
    return { interrupt: async () => undefined, promise: run.promise };
  };
  const rootTask = routingManager.create({
    name: "worker",
    ownerTurnId: "turn-root",
    prompt: "root work",
    sessionId: "session-routing",
    start: routingStart,
  });
  const nestedTask = routingManager.create({
    name: "explorer",
    ownerTurnId: "turn-root",
    prompt: "nested work",
    recipientTaskId: "reviewer-task",
    responseTurnId: "turn-reviewer-hidden",
    sessionId: "session-routing",
    start: routingStart,
  });
  routingRuns.get(rootTask.taskId)!.resolve({ history: [], output: "root response" });
  routingRuns.get(nestedTask.taskId)!.resolve({ history: [], output: "nested response" });
  await routingManager.wait("session-routing", rootTask.taskId, 1_000);
  await routingManager.wait("session-routing", nestedTask.taskId, 1_000);
  const rootResponses = routingManager.drainResponses("session-routing");
  const reviewerResponses = routingManager.drainResponses(
    "session-routing",
    "reviewer-task",
  );
  assert(rootResponses.length === 1, "main loop drains only root-addressed responses");
  assert(rootResponses[0]?.taskId === rootTask.taskId, "root response reaches main loop");
  assert(reviewerResponses.length === 1, "reviewer drains only its nested responses");
  assert(
    reviewerResponses[0]?.ownerTurnId === "turn-reviewer-hidden",
    "nested response stays attached to the reviewer turn",
  );
  assert(
    routingManager.listForOwner("session-routing", "reviewer-task")[0]?.taskId ===
      nestedTask.taskId,
    "nested task ownership is isolated",
  );
  assert(
    !("latestOutput" in withoutSubagentOutput(routingManager.list("session-routing")[0]!)),
    "wait/list payload sanitization can omit completed output",
  );

  const wakeManager = createSubagentManager();
  const wakeRun = deferred<SubagentRunResult>();
  const wakeTask = wakeManager.create({
    name: "explorer",
    ownerTurnId: "turn-wake",
    prompt: "finish during a long wait",
    sessionId: "session-wake",
    start: () => ({ interrupt: async () => undefined, promise: wakeRun.promise }),
  });
  const waitStartedAt = Date.now();
  const longWait = wakeManager.wait("session-wake", wakeTask.taskId, 600_000);
  setTimeout(() => wakeRun.resolve({ history: [], output: "ready" }), 5);
  const earlyWake = await longWait;
  assert(!earlyWake.timedOut, "completion resolves a long wait before its timeout");
  assert(Date.now() - waitStartedAt < 1_000, "completion forcibly wakes the main loop");

  console.log("subagent-manager tests passed");
}

await main();
