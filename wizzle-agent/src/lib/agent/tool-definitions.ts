import type { ProxyToolDefinition } from "../chat-stream";
import { resolveReadToolDescription } from "../image-capability";
import type { ModelCapability } from "../../types/workspace";
import {
  DEFAULT_TOOL_TIMEOUT,
  TOOL_TIMEOUT_DESCRIPTION,
  TOOL_TIMEOUT_OPTIONS,
} from "./tool-timeouts";

export const TOOL_SCHEMA_VERSION = 14;

type JsonSchema = Record<string, unknown>;

type ToolName = "bash" | "clarify" | "edit" | "read" | "subagent" | "todo" | "write";

export type ToolProviderFormat = "anthropic" | "google" | "openai_compatible";

type WizzleToolDefinition = {
  description: string;
  name: ToolName;
  parameters: JsonSchema;
  schemaVersion: number;
};

export type AnthropicToolDefinition = {
  description: string;
  input_schema: JsonSchema;
  name: string;
};

export type GoogleToolDefinition = {
  function_declarations: Array<{
    description: string;
    name: string;
    parameters: JsonSchema;
  }>;
};

function createTimeoutProperty() {
  return {
    default: DEFAULT_TOOL_TIMEOUT,
    description: TOOL_TIMEOUT_DESCRIPTION,
    enum: [...TOOL_TIMEOUT_OPTIONS],
    type: "string",
  } as const;
}

export function buildReadToolDefinition(imageCapable: boolean): WizzleToolDefinition {
  return {
    description: resolveReadToolDescription(imageCapable),
    name: "read",
    parameters: {
      additionalProperties: false,
      properties: {
        limit: {
          default: 2000,
          description:
            "Maximum number of lines to return. Capped at 2000.",
          maximum: 2000,
          minimum: 1,
          type: "integer",
        },
        offset: {
          default: 1,
          description:
            "1-based line number to start reading from when paging through a text file.",
          minimum: 1,
          type: "integer",
        },
        path: {
          description:
            "Path to read, relative to the selected project root unless absolute. Global skill files under ~/.wizzle/skills/ are also allowed.",
          type: "string",
        },
      },
      required: ["path"],
      type: "object",
    },
    schemaVersion: TOOL_SCHEMA_VERSION,
  };
}

/** Default read tool (image-capable). Prefer `buildReadToolDefinition` for the active model. */
export const READ_TOOL: WizzleToolDefinition = buildReadToolDefinition(true);

export const WRITE_TOOL: WizzleToolDefinition = {
  description:
    "Create or fully replace a text file inside the selected project. Use this when you want to write the complete file contents.",
  name: "write",
  parameters: {
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
      },
      path: {
        description:
          "Path to write, relative to the selected project root unless absolute. Paths outside the project require approval.",
        type: "string",
      },
    },
    required: ["path", "content"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

export const EDIT_TOOL: WizzleToolDefinition = {
  description:
    "Edit an existing text file by replacing an exact snippet. Prefer this over write when making a targeted change.",
  name: "edit",
  parameters: {
    additionalProperties: false,
    properties: {
      newText: {
        type: "string",
      },
      oldText: {
        type: "string",
      },
      path: {
        description:
          "Path to edit, relative to the selected project root unless absolute. Paths outside the project require approval.",
        type: "string",
      },
      replaceAll: {
        type: "boolean",
      },
    },
    required: ["path", "oldText", "newText"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

export const BASH_TOOL: WizzleToolDefinition = {
  description:
    "Run or manage host shell commands with the selected project as the working directory. Shell commands are not filesystem- or network-sandboxed and can access anything permitted to the Wizzle OS user. Use action \"run\" for git inspection, rg searches, tests, formatting, and other terminal tasks. Use background: true only for long-running dev servers or watchers, then inspect with list_processes/read_process and stop with stop_process.",
  name: "bash",
  parameters: {
    additionalProperties: false,
    properties: {
      action: {
        default: "run",
        enum: ["run", "list_processes", "read_process", "stop_process"],
        type: "string",
      },
      background: {
        default: false,
        type: "boolean",
      },
      command: {
        description: "Shell command to run when action is run.",
        type: "string",
      },
      description: {
        description:
          "Short user-facing description of why the command is needed, used in approval prompts.",
        type: "string",
      },
      cwd: {
        description:
          "Optional working directory, relative to the selected project root unless absolute. External directories require approval. Defaults to the project root.",
        type: "string",
      },
      processId: {
        description: "Process ID returned by a background run for read_process or stop_process.",
        type: "string",
      },
      timeout: createTimeoutProperty(),
    },
    required: [],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

export const TODO_TOOL: WizzleToolDefinition = {
  description:
    "Maintain the single durable TODO list for this session. Create it before multi-step coding work, update one item at a time, and finish every active item before replying. Recognized create types are creating_project, fixing_bugs, and adding_features; these automatically receive recommended items in the proper positions. Other type strings remain valid. Creating another list is rejected while unfinished items exist.",
  name: "todo",
  parameters: {
    additionalProperties: false,
    properties: {
      action: {
        enum: ["create", "add", "update", "status", "clear"],
        type: "string",
      },
      type: {
        description:
          "Create only. Prefer creating_project, fixing_bugs, or adding_features when matched so the library can enrich the list; otherwise use a short descriptive type.",
        type: "string",
      },
      items: {
        description: "Create only. One to thirty initial task titles in execution order.",
        items: { type: "string" },
        maxItems: 30,
        minItems: 1,
        type: "array",
      },
      item: {
        description: "Add only. New task title; inserted before final verification or review items.",
        type: "string",
      },
      itemId: {
        description: "Update only. Item ID from the current session TODO.",
        type: "string",
      },
      status: {
        description: "Update only. Cancel only when the user removed or replaced that scope.",
        enum: ["pending", "in_progress", "completed", "cancelled"],
        type: "string",
      },
    },
    required: ["action"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

export const CLARIFY_TOOL: WizzleToolDefinition = {
  description:
    "Ask exactly one blocking user decision and continue the same agent turn with the answer. Use doubt for missing information and approach for implementation choices. Omit choices for freeform; with choices, omit allowCustomAnswer or set it true for mixed answers, and set it false for selection-only. Do not stop and ask in assistant text.",
  name: "clarify",
  parameters: {
    additionalProperties: false,
    properties: {
      allowCustomAnswer: {
        description: "With choices only. False makes them selection-only; true or omitted also allows a typed answer.",
        type: "boolean",
      },
      kind: { enum: ["doubt", "approach"], type: "string" },
      prompt: { description: "One concise question for the user.", type: "string" },
      choices: {
        description: "Optional two or three concise choices. Omit for a free-text doubt.",
        items: { type: "string" },
        maxItems: 3,
        minItems: 2,
        type: "array",
      },
      recommended: {
        description: "Optional zero-based index into choices, normally used for approach.",
        minimum: 0,
        maximum: 2,
        type: "integer",
      },
    },
    required: ["kind", "prompt"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

export const SUBAGENT_TOOL: WizzleToolDefinition = {
  description:
    "Delegate a clear bounded task to a reusable asynchronous subagent. One subagent per role is retained: creating an existing role interrupts and removes the old task, then starts a fresh one. Never duplicate its task. While it runs, do other clearly separate work when available; otherwise wait. Completion ends a wait immediately, even with a long timeout, and injects the response automatically. A timeout is not failure: wait again unless the result is no longer needed. Maximum 3 per session.",
  name: "subagent",
  parameters: {
    additionalProperties: false,
    properties: {
      action: {
        enum: ["create", "send_message", "interrupt", "list", "wait"],
        type: "string",
      },
      prompt: {
        description:
          "Clear bounded task for create, or new substantive instructions for a continuation. Include every relevant user constraint. Do not use send_message to ask for status or early findings.",
        type: "string",
      },
      name: {
        description:
          "Role for a newly created subagent. Creating a role that already exists replaces its prior task; use send_message instead when continuing the existing task.",
        enum: ["reviewer", "explorer", "worker"],
        type: "string",
      },
      join: {
        description:
          "required when the final answer depends on this result; optional only when the result may be safely abandoned if it becomes unnecessary.",
        enum: ["required", "optional"],
        type: "string",
      },
      taskId: {
        description: "Subagent task ID returned by create or list.",
        type: "string",
      },
      timeoutMs: {
        default: "5m",
        description:
          "Used only when action is wait. Maximum wait window; completion wakes the main agent immediately. Prefer minutes and use 30s only for an obviously tiny, predictable task. If it times out, wait again unless the task is no longer needed.",
        enum: ["30s", "1m", "2m", "5m", "10m"],
        type: "string",
      },
    },
    required: ["action"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

export function resolveVersionedAgentToolDefinitions(options?: {
  imageCapable?: boolean;
  includeSubagent?: boolean;
  modelCapabilities?: ModelCapability[];
}) {
  const imageCapable =
    options?.imageCapable ??
    (options?.modelCapabilities ? options.modelCapabilities.includes("image") : true);

  return [
    TODO_TOOL,
    CLARIFY_TOOL,
    buildReadToolDefinition(imageCapable),
    WRITE_TOOL,
    EDIT_TOOL,
    BASH_TOOL,
    ...(options?.includeSubagent === false ? [] : [SUBAGENT_TOOL]),
  ];
}

function toOpenAiToolDefinition(tool: WizzleToolDefinition): ProxyToolDefinition {
  return {
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    },
    type: "function",
  };
}

function toAnthropicToolDefinition(tool: WizzleToolDefinition): AnthropicToolDefinition {
  return {
    description: tool.description,
    input_schema: tool.parameters,
    name: tool.name,
  };
}

function toGoogleToolDefinitions(tools: WizzleToolDefinition[]): GoogleToolDefinition[] {
  return [
    {
      function_declarations: tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
        parameters: tool.parameters,
      })),
    },
  ];
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashString(value: string) {
  let hash = 0xcbf29ce4;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function resolveToolDefinitionsMetadata() {
  const canonicalJson = stableJsonStringify(resolveVersionedAgentToolDefinitions());

  return {
    hash: `tooldefs-v${TOOL_SCHEMA_VERSION}-${hashString(canonicalJson)}`,
    json: canonicalJson,
    schemaVersion: TOOL_SCHEMA_VERSION,
    tokens: Math.ceil(canonicalJson.length / 3.5),
  };
}

export function adaptAgentToolsForProvider(
  format: "openai_compatible",
  options?: { imageCapable?: boolean; modelCapabilities?: ModelCapability[] },
): ProxyToolDefinition[];
export function adaptAgentToolsForProvider(
  format: "anthropic",
  options?: { imageCapable?: boolean; modelCapabilities?: ModelCapability[] },
): AnthropicToolDefinition[];
export function adaptAgentToolsForProvider(
  format: "google",
  options?: { imageCapable?: boolean; modelCapabilities?: ModelCapability[] },
): GoogleToolDefinition[];
export function adaptAgentToolsForProvider(
  format: ToolProviderFormat,
  options?: { imageCapable?: boolean; modelCapabilities?: ModelCapability[] },
) {
  const tools = resolveVersionedAgentToolDefinitions(options);

  if (format === "anthropic") {
    return tools.map(toAnthropicToolDefinition);
  }

  if (format === "google") {
    return toGoogleToolDefinitions(tools);
  }

  return tools.map(toOpenAiToolDefinition);
}

/** OpenAI-compatible tool defs for the agent loop (image description depends on model). */
export function resolveAgentTools(options?: {
  imageCapable?: boolean;
  includeSubagent?: boolean;
  modelCapabilities?: ModelCapability[];
}): ProxyToolDefinition[] {
  return adaptAgentToolsForProvider("openai_compatible", options);
}
