import type { MessagePart, ToolCall, ToolResult } from "../types/workspace";

export type ParsedToolPayload = {
  afterContent?: string;
  background?: boolean;
  beforeContent?: string;
  bytesWritten?: number;
  combinedOutput?: string;
  command?: string;
  content?: string;
  created?: boolean;
  cwd?: string;
  diffTruncated?: boolean;
  endLine?: number;
  error?: string;
  exitCode?: number | null;
  imageSrc?: string;
  mimeType?: string;
  ok?: boolean;
  path?: string;
  process?: {
    id?: string;
    status?: string;
  } | null;
  replacements?: number;
  startLine?: number;
  status?: string;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
  timeout?: string;
  totalLines?: number;
  truncated?: boolean;
};

export type ToolRunEntry = {
  call: ToolCall;
  callPayload: ParsedToolPayload | null;
  detailLabel: string;
  id: string;
  isExpandable: boolean;
  kind: "bash" | "edit" | "other" | "read" | "write";
  result?: ToolResult;
  resultPayload: ParsedToolPayload | null;
  resourceLabel?: string;
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
      if (resultPayload?.background === true || resultPayload?.process?.id) {
        return "Started a background process";
      }
      if (live) {
        return "Running a command";
      }
      return "Ran a command";
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

    while (index < parts.length) {
      const currentPart = parts[index]!;

      if (currentPart.type !== "tool_call" && currentPart.type !== "tool_result") {
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
  const otherRuns = runs.filter(
    (run) => !["bash", "edit", "read", "write"].includes(run.kind),
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
