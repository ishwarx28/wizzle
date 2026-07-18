(globalThis as { __WIZZLE_ENV__?: Record<string, string | undefined> }).__WIZZLE_ENV__ = {};

export {};

const { createTestRemoteConfig } = await import("./remote-config.test-fixture.ts");
const { installRemoteConfigForTests } = await import("./remote-config.ts");
installRemoteConfigForTests(createTestRemoteConfig());
const { buildWorkspaceSystemPrompt } = await import("./agent-prompt.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const windowsPrompt = buildWorkspaceSystemPrompt({
  currentYear: 2026,
  gitTrackedState: "Git worktree with no tracked file changes.",
  globalSkillFiles: [],
  globalSkillsDir: null,
  imageCapable: true,
  instructionFiles: [],
  operatingSystem: "Windows",
  platform: "Win32",
  projectRoot: "C:\\workspace\\project",
  sessionCacheDir: null,
});

assert(windowsPrompt.includes("OS: Windows"), "Windows is identified explicitly");
assert(
  windowsPrompt.includes("Command shell: Command Prompt (cmd.exe /C)"),
  "Windows command shell is identified explicitly",
);
assert(!windowsPrompt.includes("OS: default"), "Windows is never reported as the default OS");
assert(!windowsPrompt.includes("grep -RIn"), "base prompt has no POSIX-only command example");

console.log("agent prompt tests passed");
