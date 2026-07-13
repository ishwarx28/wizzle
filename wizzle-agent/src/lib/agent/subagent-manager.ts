import type { Message } from "../../types/workspace";

export const MAX_SUBAGENTS_PER_SESSION = 3;
export const MAX_SUBAGENTS_ERROR = "reuse existing, max 3 allowed";

export const SUBAGENT_NAMES = ["reviewer", "explorer", "worker"] as const;

export type SubagentName = (typeof SUBAGENT_NAMES)[number];
export type SubagentStatus =
  | "completed"
  | "error"
  | "interrupted"
  | "waiting_permission"
  | "working";
export type SubagentJoin = "optional" | "required";

export type SubagentRunResult = {
  history: Message[];
  output: string;
};

export type SubagentRunHandle = {
  interrupt: () => Promise<void>;
  promise: Promise<SubagentRunResult>;
};

export type StartSubagentRun = (input: {
  history: Message[];
  name: SubagentName;
  onUpdate: (history: Message[]) => void;
  prompt: string;
  taskId: string;
}) => SubagentRunHandle;

export type SubagentResponse = {
  completedAtMs: number;
  join: SubagentJoin;
  output: string;
  sequence: number;
  status: "completed" | "error" | "interrupted";
  name: SubagentName;
  ownerTurnId: string;
  recipientTaskId: string | null;
  task: string;
  taskId: string;
  trigger?: "manual";
};

export type SubagentSnapshot = {
  activeOwnerTurnId: string | null;
  completedAtMs: number | null;
  createdAtMs: number;
  interruptedAtMs: number | null;
  join: SubagentJoin;
  latestOutput: string | null;
  name: SubagentName;
  ownerTaskId: string | null;
  pendingMessageCount: number;
  status: SubagentStatus;
  task: string;
  taskId: string;
  updatedAtMs: number;
};

type QueuedMessage = {
  ownerTurnId: string;
  prompt: string;
  recipientTaskId: string | null;
  responseTurnId: string;
  start: StartSubagentRun;
};

type SubagentEntry = {
  activeInterrupt: (() => Promise<void>) | null;
  activeOwnerTurnId: string | null;
  activeRecipientTaskId: string | null;
  completedAtMs: number | null;
  createdAtMs: number;
  generation: number;
  history: Message[];
  interruptedAtMs: number | null;
  join: SubagentJoin;
  latestOutput: string | null;
  name: SubagentName;
  ownerTaskId: string | null;
  queue: QueuedMessage[];
  responseSequence: number;
  status: SubagentStatus;
  task: string;
  taskId: string;
  updatedAtMs: number;
  waiters: Set<() => void>;
};

type SessionRegistry = {
  entries: Map<string, SubagentEntry>;
  responses: SubagentResponse[];
  subscribers: Set<() => void>;
};

function isActiveStatus(status: SubagentStatus) {
  return status === "working" || status === "waiting_permission";
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return typeof error === "string" && error.trim() ? error : "The subagent failed.";
}

function snapshot(entry: SubagentEntry): SubagentSnapshot {
  return {
    activeOwnerTurnId: entry.activeOwnerTurnId,
    completedAtMs: entry.completedAtMs,
    createdAtMs: entry.createdAtMs,
    interruptedAtMs: entry.interruptedAtMs,
    join: entry.join,
    latestOutput: entry.latestOutput,
    name: entry.name,
    ownerTaskId: entry.ownerTaskId,
    pendingMessageCount: entry.queue.length,
    status: entry.status,
    task: entry.task,
    taskId: entry.taskId,
    updatedAtMs: entry.updatedAtMs,
  };
}

export function withoutSubagentOutput(snapshotValue: SubagentSnapshot) {
  const { latestOutput: _latestOutput, ...snapshotWithoutOutput } = snapshotValue;
  return snapshotWithoutOutput;
}

export function createSubagentManager() {
  const sessions = new Map<string, SessionRegistry>();

  const getSession = (sessionId: string) => {
    let registry = sessions.get(sessionId);

    if (!registry) {
      registry = { entries: new Map(), responses: [], subscribers: new Set() };
      sessions.set(sessionId, registry);
    }

    return registry;
  };

  const emit = (sessionId: string) => {
    for (const subscriber of sessions.get(sessionId)?.subscribers ?? []) {
      subscriber();
    }
  };

  const notifyWaiters = (entry: SubagentEntry) => {
    for (const notify of entry.waiters) {
      notify();
    }
    entry.waiters.clear();
  };

  const startNext = (sessionId: string, entry: SubagentEntry) => {
    const queued = entry.queue.shift();

    if (!queued) {
      if (entry.status === "working") {
        entry.status = "completed";
        entry.updatedAtMs = Date.now();
        entry.completedAtMs = entry.updatedAtMs;
      }
      entry.activeInterrupt = null;
      entry.activeOwnerTurnId = null;
      entry.activeRecipientTaskId = null;
      notifyWaiters(entry);
      emit(sessionId);
      return;
    }

    entry.status = "working";
    entry.updatedAtMs = Date.now();
    entry.completedAtMs = null;
    entry.interruptedAtMs = null;
    entry.activeOwnerTurnId = queued.ownerTurnId;
    entry.activeRecipientTaskId = queued.recipientTaskId;
    const generation = entry.generation + 1;
    entry.generation = generation;
    let handle: SubagentRunHandle;
    try {
      handle = queued.start({
        history: [...entry.history],
        name: entry.name,
        onUpdate: (history) => {
          if (entry.generation !== generation) {
            return;
          }
          entry.history = [...history];
          entry.updatedAtMs = Date.now();
          emit(sessionId);
        },
        prompt: queued.prompt,
        taskId: entry.taskId,
      });
    } catch (error) {
      handle = {
        interrupt: async () => undefined,
        promise: Promise.reject(error),
      };
    }
    entry.activeInterrupt = handle.interrupt;
    emit(sessionId);

    void handle.promise
      .then((result) => {
        if (entry.generation !== generation) {
          return;
        }

        entry.history = result.history;
        entry.latestOutput = result.output;
        entry.updatedAtMs = Date.now();
        // A message sent while work is active is a continuation, not a second
        // completed response. Only inject the consolidated result after the queue drains.
        if (entry.queue.length === 0) {
          entry.responseSequence += 1;
          getSession(sessionId).responses.push({
            completedAtMs: entry.updatedAtMs,
            join: entry.join,
            output: result.output,
            sequence: entry.responseSequence,
            status: "completed",
            name: entry.name,
            ownerTurnId: queued.responseTurnId,
            recipientTaskId: queued.recipientTaskId,
            task: entry.task,
            taskId: entry.taskId,
          });
        }
        startNext(sessionId, entry);
      })
      .catch((error) => {
        if (entry.generation !== generation) {
          return;
        }

        const output = errorMessage(error);
        entry.latestOutput = output;
        entry.responseSequence += 1;
        entry.status = "error";
        entry.updatedAtMs = Date.now();
        entry.completedAtMs = entry.updatedAtMs;
        entry.activeInterrupt = null;
        entry.activeOwnerTurnId = null;
        entry.activeRecipientTaskId = null;
        entry.queue = [];
        getSession(sessionId).responses.push({
          completedAtMs: entry.updatedAtMs,
          join: entry.join,
          output,
          sequence: entry.responseSequence,
          status: "error",
          name: entry.name,
          ownerTurnId: queued.responseTurnId,
          recipientTaskId: queued.recipientTaskId,
          task: entry.task,
          taskId: entry.taskId,
        });
        notifyWaiters(entry);
        emit(sessionId);
      });
  };

  const enqueue = (
    sessionId: string,
    entry: SubagentEntry,
    ownerTurnId: string,
    prompt: string,
    recipientTaskId: string | null,
    responseTurnId: string,
    start: StartSubagentRun,
  ) => {
    entry.queue.push({ ownerTurnId, prompt, recipientTaskId, responseTurnId, start });
    entry.updatedAtMs = Date.now();
    emit(sessionId);

    if (!entry.activeInterrupt) {
      startNext(sessionId, entry);
    }
  };

  const interruptEntry = async (
    sessionId: string,
    entry: SubagentEntry,
    trigger: "agent" | "automatic" | "manual",
  ) => {
    const stateAtInterruption = entry.status;
    const ownerTurnId = entry.activeOwnerTurnId ?? "";
    const interrupt = entry.activeInterrupt;
    entry.generation += 1;
    entry.activeInterrupt = null;
    entry.activeOwnerTurnId = null;
    entry.activeRecipientTaskId = null;
    entry.queue = [];
    entry.status = "interrupted";
    entry.updatedAtMs = Date.now();
    entry.interruptedAtMs = entry.updatedAtMs;
    notifyWaiters(entry);
    if (trigger === "manual") {
      entry.responseSequence += 1;
      getSession(sessionId).responses.push({
        completedAtMs: entry.updatedAtMs,
        join: entry.join,
        name: entry.name,
        ownerTurnId,
        output: [
          `The ${entry.name} subagent was interrupted manually by the user.`,
          `Task: ${entry.task}`,
          `State at interruption: ${stateAtInterruption}`,
        ].join("\n"),
        sequence: entry.responseSequence,
        status: "interrupted",
        recipientTaskId: null,
        task: entry.task,
        taskId: entry.taskId,
        trigger: "manual",
      });
    }
    emit(sessionId);
    await interrupt?.().catch(() => undefined);
    emit(sessionId);
  };

  return {
    create(options: {
      join?: SubagentJoin;
      name: SubagentName;
      ownerTurnId: string;
      prompt: string;
      recipientTaskId?: string | null;
      responseTurnId?: string;
      sessionId: string;
      start: StartSubagentRun;
    }) {
      const registry = getSession(options.sessionId);
      const existingRoleEntry = Array.from(registry.entries.values()).find(
        (entry) => entry.name === options.name,
      );

      if (existingRoleEntry) {
        void interruptEntry(options.sessionId, existingRoleEntry, "automatic");
        registry.entries.delete(existingRoleEntry.taskId);
        registry.responses = registry.responses.filter(
          (response) => response.taskId !== existingRoleEntry.taskId,
        );
        emit(options.sessionId);
      }

      if (registry.entries.size >= MAX_SUBAGENTS_PER_SESSION) {
        throw new Error(MAX_SUBAGENTS_ERROR);
      }

      const now = Date.now();
      const taskId = `subagent-${crypto.randomUUID()}`;
      const entry: SubagentEntry = {
        activeInterrupt: null,
        activeOwnerTurnId: null,
        activeRecipientTaskId: null,
        completedAtMs: null,
        createdAtMs: now,
        generation: 0,
        history: [],
        interruptedAtMs: null,
        join: options.join ?? "required",
        latestOutput: null,
        name: options.name,
        ownerTaskId: options.recipientTaskId ?? null,
        queue: [],
        responseSequence: 0,
        status: "working",
        task: options.prompt,
        taskId,
        updatedAtMs: now,
        waiters: new Set(),
      };
      registry.entries.set(taskId, entry);
      enqueue(
        options.sessionId,
        entry,
        options.ownerTurnId,
        options.prompt,
        options.recipientTaskId ?? null,
        options.responseTurnId ?? options.ownerTurnId,
        options.start,
      );
      return snapshot(entry);
    },

    drainResponses(sessionId: string, recipientTaskId: string | null = null) {
      const registry = sessions.get(sessionId);

      if (!registry || registry.responses.length === 0) {
        return [];
      }

      const responses = registry.responses.filter(
        (response) => response.recipientTaskId === recipientTaskId,
      );
      registry.responses = registry.responses.filter(
        (response) => response.recipientTaskId !== recipientTaskId,
      );
      return responses;
    },

    async interrupt(sessionId: string, taskId: string) {
      const entry = sessions.get(sessionId)?.entries.get(taskId);

      if (!entry) {
        throw new Error(`Unknown subagent task ID: ${taskId}`);
      }

      if (!isActiveStatus(entry.status)) {
        return snapshot(entry);
      }

      await interruptEntry(sessionId, entry, "agent");
      return snapshot(entry);
    },

    async interruptManually(sessionId: string, taskId: string) {
      const entry = sessions.get(sessionId)?.entries.get(taskId);

      if (!entry) {
        throw new Error(`Unknown subagent task ID: ${taskId}`);
      }

      if (!isActiveStatus(entry.status)) {
        return snapshot(entry);
      }

      await interruptEntry(sessionId, entry, "manual");
      return snapshot(entry);
    },

    async interruptAll(sessionId: string) {
      const entries = Array.from(sessions.get(sessionId)?.entries.values() ?? []).filter(
        (entry) => isActiveStatus(entry.status),
      );
      await Promise.all(entries.map((entry) => interruptEntry(sessionId, entry, "automatic")));
    },

    async interruptTurn(sessionId: string, turnId: string) {
      const entries = Array.from(sessions.get(sessionId)?.entries.values() ?? []).filter(
        (entry) =>
          isActiveStatus(entry.status) &&
          (entry.activeOwnerTurnId === turnId ||
            entry.queue.some((message) => message.ownerTurnId === turnId)),
      );
      await Promise.all(entries.map((entry) => interruptEntry(sessionId, entry, "automatic")));
    },

    list(sessionId: string) {
      return Array.from(sessions.get(sessionId)?.entries.values() ?? []).map(snapshot);
    },

    listForOwner(sessionId: string, ownerTaskId: string) {
      return Array.from(sessions.get(sessionId)?.entries.values() ?? [])
        .filter((entry) => entry.ownerTaskId === ownerTaskId)
        .map(snapshot);
    },

    listActiveForOwner(sessionId: string, ownerTaskId: string) {
      return Array.from(sessions.get(sessionId)?.entries.values() ?? [])
        .filter(
          (entry) => isActiveStatus(entry.status) && entry.ownerTaskId === ownerTaskId,
        )
        .map(snapshot);
    },

    listActiveForTurn(sessionId: string, turnId: string) {
      return Array.from(sessions.get(sessionId)?.entries.values() ?? [])
        .filter(
          (entry) => isActiveStatus(entry.status) && entry.activeOwnerTurnId === turnId,
        )
        .map(snapshot);
    },

    hasActiveForRecipient(sessionId: string, recipientTaskId: string | null) {
      return Array.from(sessions.get(sessionId)?.entries.values() ?? []).some(
        (entry) =>
          isActiveStatus(entry.status) &&
          entry.ownerTaskId === recipientTaskId,
      );
    },

    hasActiveForTurn(sessionId: string, turnId: string) {
      return Array.from(sessions.get(sessionId)?.entries.values() ?? []).some(
        (entry) => isActiveStatus(entry.status) && entry.activeOwnerTurnId === turnId,
      );
    },

    hasResponses(sessionId: string, recipientTaskId: string | null = null) {
      return Boolean(
        sessions
          .get(sessionId)
          ?.responses.some((response) => response.recipientTaskId === recipientTaskId),
      );
    },

    async interruptForRecipient(sessionId: string, recipientTaskId: string) {
      const entries = Array.from(sessions.get(sessionId)?.entries.values() ?? []).filter(
        (entry) =>
          isActiveStatus(entry.status) &&
          entry.ownerTaskId === recipientTaskId,
      );
      await Promise.all(
        entries.map((entry) => interruptEntry(sessionId, entry, "automatic")),
      );
    },

    conversation(sessionId: string, taskId: string) {
      return [...(sessions.get(sessionId)?.entries.get(taskId)?.history ?? [])];
    },

    setWaitingForPermission(sessionId: string, taskId: string, waiting: boolean) {
      const entry = sessions.get(sessionId)?.entries.get(taskId);
      if (!entry || !isActiveStatus(entry.status)) {
        return;
      }
      entry.status = waiting ? "waiting_permission" : "working";
      entry.updatedAtMs = Date.now();
      emit(sessionId);
    },

    subscribe(sessionId: string, subscriber: () => void) {
      const registry = getSession(sessionId);
      registry.subscribers.add(subscriber);
      return () => {
        registry.subscribers.delete(subscriber);
      };
    },

    sendMessage(options: {
      ownerTurnId: string;
      prompt: string;
      recipientTaskId?: string | null;
      responseTurnId?: string;
      sessionId: string;
      start: StartSubagentRun;
      taskId: string;
    }) {
      const entry = sessions.get(options.sessionId)?.entries.get(options.taskId);

      if (!entry) {
        throw new Error(`Unknown subagent task ID: ${options.taskId}`);
      }

      enqueue(
        options.sessionId,
        entry,
        options.ownerTurnId,
        options.prompt,
        options.recipientTaskId ?? null,
        options.responseTurnId ?? options.ownerTurnId,
        options.start,
      );
      return snapshot(entry);
    },

    async wait(sessionId: string, taskId: string, timeoutMs: number) {
      const entry = sessions.get(sessionId)?.entries.get(taskId);

      if (!entry) {
        throw new Error(`Unknown subagent task ID: ${taskId}`);
      }

      if (!isActiveStatus(entry.status)) {
        return { snapshot: snapshot(entry), timedOut: false };
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let notify: (() => void) | undefined;
      const completed = new Promise<boolean>((resolve) => {
        notify = () => resolve(true);
        entry.waiters.add(notify);
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      });
      const didComplete = await completed;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (notify) {
        entry.waiters.delete(notify);
      }

      return { snapshot: snapshot(entry), timedOut: !didComplete };
    },

    async closeSession(sessionId: string) {
      const entries = Array.from(sessions.get(sessionId)?.entries.values() ?? []).filter(
        (entry) => isActiveStatus(entry.status),
      );
      await Promise.all(entries.map((entry) => interruptEntry(sessionId, entry, "automatic")));
      sessions.delete(sessionId);
    },
  };
}

export const workspaceSubagentManager = createSubagentManager();

export async function interruptWorkspaceSubagents(sessionId: string) {
  await workspaceSubagentManager.interruptAll(sessionId);
}

export async function closeWorkspaceSubagents(sessionId: string) {
  await workspaceSubagentManager.closeSession(sessionId);
}
