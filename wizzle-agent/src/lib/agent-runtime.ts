import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AgentInstructionFile = {
  name: string;
  path: string;
};

export type AgentGlobalSkillFile = {
  description: string | null;
  name: string;
  path: string;
};

export type AgentProjectContext = {
  gitTrackedState: string;
  globalSkillFiles: AgentGlobalSkillFile[];
  globalSkillsDir: string | null;
  instructionFiles: AgentInstructionFile[];
  projectId: string;
  projectRoot: string;
  sessionCacheDir: string | null;
};

export type AgentToolRunResult = {
  error?: string | null;
  output?: string | null;
  status: string;
};

export type AgentToolOutputChunk = {
  chunk: string;
  stream: "stderr" | "stdout";
  toolCallId: string;
};

export type AgentToolApprovalResult = {
  approved: boolean;
  token?: string | null;
};

export async function loadAgentProjectContext(projectId: string, sessionId?: string) {
  return invoke<AgentProjectContext>("load_agent_project_context", { projectId, sessionId });
}

export async function runAgentTool(input: {
  approvalToken?: string;
  arguments: string;
  /** When false, read on image files returns an error instead of image data. */
  imageCapable?: boolean;
  onChunk?: (chunk: AgentToolOutputChunk) => void;
  projectId: string;
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
  /** Links background processes to this conversation turn (#75). */
  turnId?: string;
}) {
  const { onChunk, imageCapable = true, ...rest } = input;
  const invokeInput = {
    ...rest,
    imageCapable,
  };
  const unlisten = await listen<AgentToolOutputChunk>("agent-tool-chunk", (event) => {
    if (!onChunk || !invokeInput.toolCallId || event.payload.toolCallId !== invokeInput.toolCallId) {
      return;
    }

    onChunk(event.payload);
  });

  try {
    return await invoke<AgentToolRunResult>("run_agent_tool", {
      input: invokeInput,
    });
  } finally {
    unlisten();
  }
}

export async function requestAgentToolApproval(input: {
  arguments: string;
  projectId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
}) {
  return invoke<AgentToolApprovalResult>("request_agent_tool_approval", { input });
}
