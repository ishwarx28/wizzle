import type { AgentGlobalSkillFile, AgentInstructionFile } from "./agent-runtime";
import baseSystemPrompt from "./prompts/system-prompt.txt?raw";

const MISSING_AGENTS_FILE =
  "No AGENTS.md file is currently available for this project. Treat this as already checked unless the user asks or there is reason to think it changed.";
const MISSING_GLOBAL_SKILLS_DIR =
  "Home directory not available on this system, so ~/.wizzle/skills/ could not be resolved.";
const MISSING_GLOBAL_SKILLS_INVENTORY = "No global skill files are currently available.";
const MISSING_SESSION_CACHE_DIR =
  "No session cache directory is available for this run.";

function resolveAgentsInstructionFile(instructionFiles: AgentInstructionFile[]) {
  return instructionFiles.find((file) => file.name === "AGENTS.md") ?? null;
}

function buildPathList(paths: string[], emptyMessage: string) {
  if (paths.length === 0) {
    return emptyMessage;
  }

  return paths.map((path) => `- ${path}`).join("\n");
}

function buildEnvironmentBlock(options: {
  currentYear: number;
  gitTrackedState: string;
  imageCapable: boolean;
  operatingSystem: string;
  platform: string;
  projectRoot: string;
}) {
  return [
    "# Runtime Environment",
    `Project root: ${options.projectRoot}`,
    `Current year: ${options.currentYear}`,
    `Platform: ${options.platform}`,
    `OS: ${options.operatingSystem}`,
    `Git tracked state: ${options.gitTrackedState || "Unknown."}`,
    // Tell the model not to read images when the selected model cannot view them (#40/#41).
    options.imageCapable ? "image: enabled" : "image: disabled",
  ].join("\n");
}

function buildAgentsBlock(instructionFiles: AgentInstructionFile[]) {
  const agentsInstructionFile = resolveAgentsInstructionFile(instructionFiles);

  return [
    "# Project Instruction Files",
    agentsInstructionFile
      ? [
          `AGENTS.md path: ${agentsInstructionFile.path}`,
          "Read this file with the `read` tool before relying on project-specific instructions, then follow it.",
        ].join("\n")
      : MISSING_AGENTS_FILE,
  ].join("\n");
}

function buildGlobalSkillsBlock(options: {
  globalSkillFiles: AgentGlobalSkillFile[];
  globalSkillsDir: string | null;
}) {
  const globalSkillsDir = options.globalSkillsDir ?? MISSING_GLOBAL_SKILLS_DIR;
  const skillPaths = options.globalSkillFiles.map((file) => file.path);

  return [
    "# Global Skill Files",
    `Global skills directory: ${globalSkillsDir}`,
    "",
    "Available skill paths:",
    buildPathList(skillPaths, MISSING_GLOBAL_SKILLS_INVENTORY),
  ].join("\n");
}

function buildSessionCacheBlock(sessionCacheDir: string | null) {
  return [
    "# Session Cache",
    `Session cache directory: ${sessionCacheDir ?? MISSING_SESSION_CACHE_DIR}`,
  ].join("\n");
}

export function buildWorkspaceSystemPrompt(options: {
  currentYear: number;
  gitTrackedState: string;
  globalSkillFiles: AgentGlobalSkillFile[];
  globalSkillsDir: string | null;
  /** When false, environment includes `image: disabled` so the model avoids image reads. */
  imageCapable?: boolean;
  instructionFiles: AgentInstructionFile[];
  operatingSystem: string;
  platform: string;
  projectRoot: string;
  sessionCacheDir: string | null;
}) {
  const imageCapable = options.imageCapable ?? true;

  return [
    baseSystemPrompt.trim(),
    buildEnvironmentBlock({
      currentYear: options.currentYear,
      gitTrackedState: options.gitTrackedState,
      imageCapable,
      operatingSystem: options.operatingSystem,
      platform: options.platform,
      projectRoot: options.projectRoot,
    }),
    buildAgentsBlock(options.instructionFiles),
    buildGlobalSkillsBlock({
      globalSkillFiles: options.globalSkillFiles,
      globalSkillsDir: options.globalSkillsDir,
    }),
    buildSessionCacheBlock(options.sessionCacheDir),
  ].join("\n\n");
}
