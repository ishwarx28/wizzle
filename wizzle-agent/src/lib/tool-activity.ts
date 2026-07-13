import type { MessagePart, ToolCall, ToolResult } from "../types/workspace";

export type ParsedToolPayload = {
  action?: string;
  addedItems?: string[];
  allowCustomAnswer?: boolean;
  answer?: string;
  afterContent?: string;
  background?: boolean;
  beforeContent?: string;
  bytesWritten?: number;
  combinedOutput?: string;
  command?: string;
  choices?: string[];
  content?: string;
  created?: boolean;
  currentItem?: TodoPayloadItem;
  cwd?: string;
  diffTruncated?: boolean;
  error?: string;
  exitCode?: number | null;
  imageSrc?: string;
  limit?: number;
  latestOutput?: string | null;
  join?: string;
  item?: string;
  itemId?: string;
  items?: Array<string | TodoPayloadItem>;
  name?: string;
  kind?: string;
  mime?: string;
  mimeType?: string;
  next?: number;
  note?: string;
  persistenceWarning?: string;
  ok?: boolean;
  offset?: number;
  path?: string;
  process?: ProcessPayload | null;
  processes?: ProcessPayload[];
  processId?: string;
  prompt?: string;
  recommended?: number;
  replacements?: number;
  status?: string;
  summary?: string;
  task?: ParsedToolPayload | string;
  taskId?: string;
  tasks?: ParsedToolPayload[];
  createdAtMs?: number;
  completedAtMs?: number | null;
  interruptedAtMs?: number | null;
  updatedAtMs?: number;
  activeOwnerTurnId?: string | null;
  pendingMessageCount?: number;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
  timeout?: string;
  timeoutMs?: string;
  type?: string;
  truncated?: boolean;
};

export type ProcessPayload = {
  command?: string;
  cwd?: string;
  endedAtMs?: number | null;
  exitCode?: number | null;
  id?: string;
  pid?: number | null;
  startedAtMs?: number;
  status?: string;
  stderrTail?: string;
  stdoutTail?: string;
};

export type TodoPayloadItem = {
  addedByTemplate?: boolean;
  id?: string;
  status?: string;
  title?: string;
};

export type ToolRunEntry = {
  call: ToolCall;
  callPayload: ParsedToolPayload | null;
  detailLabel: string;
  id: string;
  isExpandable: boolean;
  kind: "bash" | "clarify" | "edit" | "other" | "read" | "subagent" | "todo" | "write";
  result?: ToolResult;
  resultPayload: ParsedToolPayload | null;
  resourceLabel?: string;
  startedAtMs?: number;
  status: string;
};

export type ActivitySegment =
  | {
      id: string;
      part: MessagePart;
      type: "part";
    }
  | {
      id: string;
      runs: ToolRunEntry[];
      type: "tool_group";
    };

function getFileName(path?: string) {
  if (!path) {
    return null;
  }

  const normalizedPath = path.replace(/\\/g, "/");
  return normalizedPath.split("/").filter(Boolean).pop() ?? normalizedPath;
}

export function parseToolPayload(value?: string) {
  if (!value?.trim()) {
    return null;
  }

  try {
    return JSON.parse(value) as ParsedToolPayload;
  } catch {
    return null;
  }
}

export function resolveClarifyToolPresentation(payload: ParsedToolPayload) {
  const choices = payload.choices ?? [];
  if (choices.length === 0) {
    return {
      answer: payload.answer,
      kind: "freeform" as const,
      question: payload.prompt ?? "—",
    };
  }

  const customAnswer = payload.answer && !choices.includes(payload.answer) ? payload.answer : null;
  return {
    choices: [...choices, ...(customAnswer ? [customAnswer] : [])].map((label) => ({
      isCustom: label === customAnswer,
      isSelected: label === payload.answer,
      label,
    })),
    kind: "choices" as const,
    question: payload.prompt ?? "—",
  };
}

function isLiveToolStatus(status?: string | null) {
  return status === "pending" || status === "running" || status === "streaming";
}

function resolveWriteLabel(resultPayload: ParsedToolPayload | null) {
  return resultPayload?.created === false ? "Edited" : "Created";
}

function buildRunDetailLabel(
  toolCall: ToolCall,
  resultPayload: ParsedToolPayload | null,
  resourceLabel?: string,
) {
  const live = isLiveToolStatus(toolCall.status) && !resultPayload;

  switch (toolCall.name) {
    case "read":
      if (live) {
        return resourceLabel ? `Reading ${resourceLabel}` : "Reading a file";
      }
      return `Read ${resourceLabel ?? "resource"}`;
    case "write":
      // I-17: mid-run label before path/result is known.
      if (live) {
        return "Creating a file";
      }
      return `${resolveWriteLabel(resultPayload)} ${resourceLabel ?? "resource"}`;
    case "edit":
      if (live) {
        return "Editing a file";
      }
      return `Edited ${resourceLabel ?? "resource"}`;
    case "bash": {
      const callPayload = parseToolPayload(toolCall.input);
      const action = callPayload?.action ?? "run";
      if (action === "list_processes") return live ? "Checking background processes" : "Checked background processes";
      if (action === "read_process") return live ? "Checking a background process" : "Checked a background process";
      if (action === "stop_process") return live ? "Stopping a background process" : "Stopped a background process";
      if (callPayload?.background === true || resultPayload?.background === true) {
        return live ? "Starting a background process" : "Started a background process";
      }
      return live ? "Running a command" : "Ran a command";
    }
    case "subagent": {
      const callPayload = parseToolPayload(toolCall.input);
      const action = resultPayload?.action ?? callPayload?.action;
      switch (action) {
        case "create":
          return "Created a subagent";
        case "interrupt":
          return "Interrupted a subagent";
        case "list":
          return "Listed subagents";
        case "wait":
          return "Waiting for subagent";
        case "send_message":
          return "Queued a subagent continuation";
        default:
          return live ? "Managing a subagent" : "Managed a subagent";
      }
    }
    case "todo": {
      const action = parseToolPayload(toolCall.input)?.action ?? resultPayload?.action ?? "status";
      if (live) return action === "status" ? "Checking TODO" : "Updating TODO";
      const labels: Record<string, string> = {
        add: "Added a TODO item",
        clear: "Cleared TODO",
        create: "Created session TODO",
        status: "Checked session TODO",
        update: "Updated a TODO item",
      };
      return labels[action] ?? "Updated session TODO";
    }
    case "clarify": {
      const kind = parseToolPayload(toolCall.input)?.kind;
      if (live) return kind === "approach" ? "Choosing an approach" : "Waiting for clarification";
      return kind === "approach" ? "Chose an approach" : "Clarified a detail";
    }
    default:
      return toolCall.name;
  }
}

function resolveToolKind(toolName: string): ToolRunEntry["kind"] {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "bash":
      return "bash";
    case "subagent":
      return "subagent";
    case "todo":
      return "todo";
    case "clarify":
      return "clarify";
    default:
      return "other";
  }
}

function isExpandableTool(
  toolCall: ToolCall,
  toolResult: ToolResult | undefined,
  resultPayload: ParsedToolPayload | null,
) {
  if (toolResult?.error?.trim()) {
    return true;
  }

  if (toolCall.name === "bash") {
    return true;
  }

  if (toolCall.name === "subagent") {
    return true;
  }

  if (toolCall.name === "todo") {
    return parseToolPayload(toolCall.input)?.action !== "clear";
  }

  if (toolCall.name === "clarify") {
    return true;
  }

  if (toolCall.name === "write" || toolCall.name === "edit") {
    return Boolean(resultPayload?.beforeContent !== undefined || resultPayload?.afterContent !== undefined);
  }

  return false;
}

function buildToolResultMap(parts: MessagePart[]) {
  const toolResultsByCallId = new Map<string, ToolResult>();

  for (const part of parts) {
    if (part.type !== "tool_result") {
      continue;
    }

    const toolCallId = part.toolCallId ?? part.id;
    toolResultsByCallId.set(toolCallId, {
      error: part.error,
      id: part.id,
      output: part.output,
      status: part.status,
      toolCallId: part.toolCallId,
    });
  }

  return toolResultsByCallId;
}

function buildToolCallMap(parts: MessagePart[]) {
  const toolCallsById = new Map<string, MessagePart>();

  for (const part of parts) {
    if (part.type !== "tool_call") {
      continue;
    }

    toolCallsById.set(part.toolCallId ?? part.id, part);
  }

  return toolCallsById;
}

function resolveToolBatchKey(
  part: MessagePart,
  toolCallsById: Map<string, MessagePart>,
) {
  const toolCallId = part.toolCallId ?? part.id;

  if (part.type === "tool_call") {
    return part.parentPartId ?? part.id;
  }

  const toolCallPart = toolCallsById.get(toolCallId);

  if (toolCallPart) {
    return toolCallPart.parentPartId ?? toolCallPart.id;
  }

  return `orphan-${part.parentPartId ?? toolCallId}`;
}

function createToolRunEntry(
  toolCallPart: MessagePart | undefined,
  toolResult: ToolResult | undefined,
): ToolRunEntry | null {
  const toolName = toolCallPart?.name ?? "tool";
  const toolCallId = toolCallPart?.toolCallId ?? toolResult?.toolCallId ?? toolCallPart?.id ?? toolResult?.id;

  if (!toolCallId) {
    return null;
  }

  const toolCall: ToolCall = {
    id: toolCallId,
    input: toolCallPart?.input,
    name: toolName,
    status: toolCallPart?.status ?? toolResult?.status,
  };
  const callPayload = parseToolPayload(toolCall.input);
  const resultPayload = parseToolPayload(toolResult?.output);
  const path = resultPayload?.path ?? callPayload?.path;
  const resourceLabel = getFileName(path) ?? undefined;

  return {
    call: toolCall,
    callPayload,
    detailLabel: buildRunDetailLabel(toolCall, resultPayload, resourceLabel),
    id: toolCall.id,
    isExpandable: isExpandableTool(toolCall, toolResult, resultPayload),
    kind: resolveToolKind(toolCall.name),
    result: toolResult,
    resultPayload,
    resourceLabel,
    startedAtMs: toolCallPart?.createdAtMs,
    status: toolResult?.status ?? toolCall.status ?? "pending",
  };
}

export function collectToolRuns(parts: MessagePart[]): ToolRunEntry[] {
  const toolResultsByCallId = buildToolResultMap(parts);

  const runs: ToolRunEntry[] = [];

  for (const part of parts) {
    if (!part || part.type !== "tool_call" || !part.name) {
      continue;
    }

    const run = createToolRunEntry(part, toolResultsByCallId.get(part.toolCallId ?? part.id));

    if (run) {
      runs.push(run);
    }
  }

  return runs;
}

export function buildActivitySegments(parts: MessagePart[]): ActivitySegment[] {
  const toolCallsById = buildToolCallMap(parts);
  const toolResultsByCallId = buildToolResultMap(parts);
  const segments: ActivitySegment[] = [];
  const emittedRunIds = new Set<string>();
  let index = 0;

  while (index < parts.length) {
    const part = parts[index]!;

    if (part.type !== "tool_call" && part.type !== "tool_result") {
      segments.push({
        id: part.id,
        part,
        type: "part",
      });
      index += 1;
      continue;
    }

    const runs: ToolRunEntry[] = [];
    const blockRunIds = new Set<string>();
    const blockBatchKey = resolveToolBatchKey(part, toolCallsById);

    while (index < parts.length) {
      const currentPart = parts[index]!;

      if (currentPart.type !== "tool_call" && currentPart.type !== "tool_result") {
        break;
      }

      if (resolveToolBatchKey(currentPart, toolCallsById) !== blockBatchKey) {
        break;
      }

      const toolCallId = currentPart.toolCallId ?? currentPart.id;

      if (!blockRunIds.has(toolCallId) && !emittedRunIds.has(toolCallId)) {
        const toolCallPart =
          currentPart.type === "tool_call" ? currentPart : toolCallsById.get(toolCallId);
        const toolResult =
          currentPart.type === "tool_result"
            ? toolResultsByCallId.get(toolCallId)
            : toolResultsByCallId.get(toolCallId);
        const run = createToolRunEntry(toolCallPart, toolResult);

        if (run) {
          runs.push(run);
          blockRunIds.add(toolCallId);
          emittedRunIds.add(toolCallId);
        }
      }

      index += 1;
    }

    if (runs.length > 0) {
      segments.push({
        id: `tool-group-${runs.map((run) => run.id).join("-")}`,
        runs,
        type: "tool_group",
      });
    }
  }

  return segments;
}

function pluralize(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function summarizeToolRuns(runs: ToolRunEntry[]) {
  if (runs.length === 0) {
    return "";
  }

  if (runs.length === 1) {
    return runs[0]?.detailLabel ?? "";
  }

  const readRuns = runs.filter((run) => run.kind === "read");
  const createdRuns = runs.filter(
    (run) => run.kind === "write" && run.resultPayload?.created !== false,
  );
  const editedRuns = runs.filter(
    (run) => run.kind === "edit" || (run.kind === "write" && run.resultPayload?.created === false),
  );
  const bashRuns = runs.filter((run) => run.kind === "bash");
  const subagentRuns = runs.filter((run) => run.kind === "subagent");
  const todoRuns = runs.filter((run) => run.kind === "todo");
  const clarifyRuns = runs.filter((run) => run.kind === "clarify");
  const otherRuns = runs.filter(
    (run) => !["bash", "clarify", "edit", "read", "subagent", "todo", "write"].includes(run.kind),
  );
  const summaryParts: string[] = [];

  if (readRuns.length === 1) {
    summaryParts.push(readRuns[0]!.detailLabel);
  } else if (readRuns.length > 1) {
    summaryParts.push(`Read ${pluralize(readRuns.length, "file")}`);
  }

  if (createdRuns.length === 1) {
    summaryParts.push(createdRuns[0]!.detailLabel);
  } else if (createdRuns.length > 1) {
    summaryParts.push(`Created ${pluralize(createdRuns.length, "file")}`);
  }

  if (editedRuns.length === 1) {
    summaryParts.push(editedRuns[0]!.detailLabel);
  } else if (editedRuns.length > 1) {
    summaryParts.push(`Edited ${pluralize(editedRuns.length, "file")}`);
  }

  if (bashRuns.length === 1) {
    summaryParts.push("Ran a command");
  } else if (bashRuns.length > 1) {
    summaryParts.push(`Ran ${pluralize(bashRuns.length, "command")}`);
  }

  if (subagentRuns.length === 1) {
    summaryParts.push(subagentRuns[0]!.detailLabel);
  } else if (subagentRuns.length > 1) {
    summaryParts.push(`Managed ${pluralize(subagentRuns.length, "subagent")}`);
  }

  if (todoRuns.length === 1) summaryParts.push(todoRuns[0]!.detailLabel);
  else if (todoRuns.length > 1) summaryParts.push(`Updated ${pluralize(todoRuns.length, "TODO item")}`);

  if (clarifyRuns.length === 1) summaryParts.push(clarifyRuns[0]!.detailLabel);
  else if (clarifyRuns.length > 1) summaryParts.push(`Resolved ${pluralize(clarifyRuns.length, "clarification")}`);

  if (otherRuns.length > 0) {
    summaryParts.push(`Used ${pluralize(otherRuns.length, "tool")}`);
  }

  return summaryParts.join(", ");
}

export function extractLinkedFileFromToolResult(message: {
  content?: string;
  status?: string;
  toolName?: string;
}) {
  if (
    message.status !== "done" ||
    !message.toolName ||
    !["edit", "read", "write"].includes(message.toolName)
  ) {
    return null;
  }

  const payload = parseToolPayload(message.content);
  const path = payload?.path;

  if (!path) {
    return null;
  }

  return {
    action:
      message.toolName === "read"
        ? "read"
        : message.toolName === "edit" || payload.created === false
          ? "edited"
          : "created",
    path,
  } as const;
}
