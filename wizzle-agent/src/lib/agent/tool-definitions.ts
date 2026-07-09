import type { ProxyToolDefinition } from "../chat-stream";
import {
  DEFAULT_TOOL_TIMEOUT,
  TOOL_TIMEOUT_DESCRIPTION,
  TOOL_TIMEOUT_OPTIONS,
} from "./tool-timeouts";

export const TOOL_SCHEMA_VERSION = 1;

type JsonSchema = Record<string, unknown>;

type ToolName = "bash" | "edit" | "read" | "write";

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

export const READ_TOOL: WizzleToolDefinition = {
  description:
    "Read a text or image file from the selected project, or a markdown skill file from ~/.wizzle/skills/. You can request a specific line range for text files. If the file is an image (png, jpg, jpeg, gif, webp, bmp, svg, avif), the result includes the image data you can view and analyze.",
  name: "read",
  parameters: {
    additionalProperties: false,
    properties: {
      endLine: {
        minimum: 1,
        type: "integer",
      },
      path: {
        description:
          "Path to read, relative to the selected project root unless absolute. Global skill files under ~/.wizzle/skills/ are also allowed.",
        type: "string",
      },
      startLine: {
        minimum: 1,
        type: "integer",
      },
      timeout: createTimeoutProperty(),
    },
    required: ["path"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

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
        description: "Path to write, relative to the selected project root unless absolute.",
        type: "string",
      },
      timeout: createTimeoutProperty(),
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
        description: "Path to edit, relative to the selected project root unless absolute.",
        type: "string",
      },
      replaceAll: {
        type: "boolean",
      },
      timeout: createTimeoutProperty(),
    },
    required: ["path", "oldText", "newText"],
    type: "object",
  },
  schemaVersion: TOOL_SCHEMA_VERSION,
};

export const BASH_TOOL: WizzleToolDefinition = {
  description:
    "Run or manage shell commands inside the selected project root. Use action \"run\" for git inspection, rg searches, tests, formatting, and other terminal tasks. Use background: true only for long-running dev servers or watchers, then inspect with list_processes/read_process and stop with stop_process.",
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
      cwd: {
        description:
          "Optional working directory relative to the selected project root. Defaults to the project root.",
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

export function resolveVersionedAgentToolDefinitions() {
  return [READ_TOOL, WRITE_TOOL, EDIT_TOOL, BASH_TOOL];
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

export function adaptAgentToolsForProvider(format: "openai_compatible"): ProxyToolDefinition[];
export function adaptAgentToolsForProvider(format: "anthropic"): AnthropicToolDefinition[];
export function adaptAgentToolsForProvider(format: "google"): GoogleToolDefinition[];
export function adaptAgentToolsForProvider(format: ToolProviderFormat) {
  const tools = resolveVersionedAgentToolDefinitions();

  if (format === "anthropic") {
    return tools.map(toAnthropicToolDefinition);
  }

  if (format === "google") {
    return toGoogleToolDefinitions(tools);
  }

  return tools.map(toOpenAiToolDefinition);
}

export function resolveAgentTools(): ProxyToolDefinition[];
export function resolveAgentTools(format: "openai_compatible"): ProxyToolDefinition[];
export function resolveAgentTools(format: "anthropic"): AnthropicToolDefinition[];
export function resolveAgentTools(format: "google"): GoogleToolDefinition[];
export function resolveAgentTools(format: ToolProviderFormat = "openai_compatible") {
  if (format === "anthropic") {
    return adaptAgentToolsForProvider("anthropic");
  }

  if (format === "google") {
    return adaptAgentToolsForProvider("google");
  }

  return adaptAgentToolsForProvider("openai_compatible");
}
