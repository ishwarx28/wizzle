import type { ProxyToolDefinition } from "../chat-stream";
import { resolveReadToolDescription } from "../image-capability";
import type { ModelCapability } from "../../types/workspace";
import {
  DEFAULT_TOOL_TIMEOUT,
  TOOL_TIMEOUT_DESCRIPTION,
  TOOL_TIMEOUT_OPTIONS,
} from "./tool-timeouts";

export const TOOL_SCHEMA_VERSION = 19;

type JsonSchema = Record<string, unknown>;

type ToolName =
  | "shell"
  | "clarify"
  | "edit"
  | "implementation_plan"
  | "read"
  | "subagent"
  | "write";

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
          default: 400,
          description:
            "Maximum number of lines to return. Defaults to 400 and is capped at 2000.",
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
    "Create or fully replace a text file inside the selected project. Use this when you want to write the complete file contents. Successful in-project mutations may include an automatic verification report; inspect and resolve newly introduced diagnostics.",
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
    "Edit an existing text file by replacing an exact snippet. Prefer this over write when making a targeted change. Successful in-project mutations may include an automatic verification report; inspect and resolve newly introduced diagnostics.",
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

export const SHELL_TOOL: WizzleToolDefinition = {
  description:
    "Run or manage commands in the host command shell shown in Runtime Environment: Command Prompt (cmd.exe /C) on Windows and POSIX shell (sh -lc) on macOS/Linux. The selected project is the default working directory. Commands are not sandboxed. Every call must choose a type. Use type \"foreground\" only when the command is finite, non-interactive, and expected to exit within its timeout, including git inspection, searches, builds, tests, and formatting. Foreground project mutations may include an automatic verification report; inspect and resolve newly introduced diagnostics. Use type \"background\" for any server, watcher, follow/tail command, or process intended to keep running; the call returns a process ID immediately, which you must inspect with read_process and stop with stop_process when no longer needed. Wizzle may automatically promote a clearly persistent foreground command to background. Use type \"foreground\" for list_processes, read_process, and stop_process actions.",
  name: "shell",
  parameters: {
    additionalProperties: false,
    properties: {
      action: {
        default: "run",
        enum: ["run", "list_processes", "read_process", "stop_process"],
        type: "string",
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
      type: {
        description:
          "Required execution type. Use foreground only for finite non-interactive work. Use background for servers, watchers, follow/tail commands, and anything intended to keep running. Process-management actions use foreground.",
        enum: ["foreground", "background"],
        type: "string",
      },
    },
    required: ["action", "type"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

const PLAN_STEP_SCHEMA = {
  additionalProperties: false,
  properties: {
    details: {
      description: "Concrete implementation or verification details, including relevant checks or constraints.",
      type: "string",
    },
    title: { description: "Concise ordered step title.", type: "string" },
  },
  required: ["title", "details"],
  type: "object",
} as const;

export const IMPLEMENTATION_PLAN_TOOL: WizzleToolDefinition = {
  description:
    "Create and execute the session's durable Markdown implementation plan. For project implementation, fixes, debugging, reviews, and new projects: inspect first without mutating the project, then call create as the only tool call and stop for user review. Create/revise requires one to three approaches, affected files, ordered implementation steps, and verification steps; bug_fix/debugging also require rootCause and intendedFix. The user approves in their next message without an approval UI: call resume with the selected approach, then start and complete exactly one ordered step at a time. Revise stops again for review. The generated path is returned for the Read plan tile.",
  name: "implementation_plan",
  parameters: {
    additionalProperties: false,
    properties: {
      action: {
        enum: ["create", "revise", "resume", "start_step", "complete_step", "status"],
        type: "string",
      },
      title: {
        description: "Create/revise only. Clear title for the Markdown plan.",
        type: "string",
      },
      goal: {
        description: "Create/revise only. User outcome this plan must achieve.",
        type: "string",
      },
      summary: {
        description: "Create/revise only. Concise technical strategy based on inspection.",
        type: "string",
      },
      taskType: {
        description: "Create/revise only. Classify the requested project task.",
        enum: ["bug_fix", "debugging", "implementation", "new_project", "review", "other"],
        type: "string",
      },
      findings: {
        description: "Create/revise only. Concrete facts learned during project inspection.",
        items: { type: "string" },
        maxItems: 50,
        type: "array",
      },
      rootCause: {
        description: "Create/revise. Required for bug_fix/debugging; evidence-backed cause of the behavior.",
        type: "string",
      },
      intendedFix: {
        description: "Create/revise. Required for bug_fix/debugging; the root fix and why it addresses the cause.",
        type: "string",
      },
      approaches: {
        description: "Create/revise only. One to three viable approaches for user review.",
        items: {
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            title: { type: "string" },
            tradeoffs: {
              items: { type: "string" },
              maxItems: 8,
              type: "array",
            },
          },
          required: ["title", "summary", "tradeoffs"],
          type: "object",
        },
        maxItems: 3,
        minItems: 1,
        type: "array",
      },
      recommendedApproach: {
        description: "Create/revise only. Zero-based index of the recommended approach.",
        maximum: 2,
        minimum: 0,
        type: "integer",
      },
      affectedFiles: {
        description: "Create/revise only. Existing or planned files affected, each with its reason.",
        items: {
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            reason: { type: "string" },
          },
          required: ["path", "reason"],
          type: "object",
        },
        maxItems: 100,
        minItems: 1,
        type: "array",
      },
      concerns: {
        description: "Create/revise only. Risks and concerns to preserve in the plan.",
        items: { type: "string" },
        maxItems: 30,
        type: "array",
      },
      gaps: {
        description: "Create/revise only. Known gaps or uncertainties; use an empty array when none remain.",
        items: { type: "string" },
        maxItems: 30,
        type: "array",
      },
      implementationSteps: {
        description: "Create/revise only. One to thirty implementation steps in strict execution order.",
        items: PLAN_STEP_SCHEMA,
        maxItems: 30,
        minItems: 1,
        type: "array",
      },
      verificationSteps: {
        description: "Create/revise only. One to ten final verification steps in strict execution order.",
        items: PLAN_STEP_SCHEMA,
        maxItems: 10,
        minItems: 1,
        type: "array",
      },
      approachId: {
        description: "Resume only. Approach ID returned by create/revise, chosen by the user or recommended by the plan.",
        type: "string",
      },
      stepId: {
        description: "Start/complete step only. Step ID from the current implementation plan.",
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
    "Ask exactly one blocking user decision and continue the same agent turn with the answer. Use doubt for missing information. Use approach only for non-project decisions; project implementation approaches must go in implementation_plan for review on the next turn. Omit choices for freeform; with choices, omit allowCustomAnswer or set it true for mixed answers, and set it false for selection-only. Do not stop and ask in assistant text.",
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
    IMPLEMENTATION_PLAN_TOOL,
    CLARIFY_TOOL,
    buildReadToolDefinition(imageCapable),
    WRITE_TOOL,
    EDIT_TOOL,
    SHELL_TOOL,
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
