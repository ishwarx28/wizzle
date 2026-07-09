import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AgentInstructionFile = {
  name: string;
  path: string;
};

export type AgentGlobalSkillFile = {
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

export async function loadAgentProjectContext(projectId: string, sessionId?: string) {
  return invoke<AgentProjectContext>("load_agent_project_context", { projectId, sessionId });
}

export async function runAgentTool(input: {
  arguments: string;
  onChunk?: (chunk: AgentToolOutputChunk) => void;
  projectId: string;
  sessionId?: string;
  toolCallId?: string;
  toolName: string;
}) {
  const { onChunk, ...invokeInput } = input;
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
