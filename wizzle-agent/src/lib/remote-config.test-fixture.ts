import type { RemoteConfig, RemotePromptId } from "../types/remote-config";

const prompts: Record<RemotePromptId, string> = {
  compaction: "Summarize the supplied history without answering it.",
  "context-pressure": [
    "You are Wizzle, a desktop coding agent.",
    "Give a brief status based on the current findings.",
    "Be concise and distinguish completed from remaining work.",
    "Do not call tools.",
  ].join("\n"),
  enhancement: "Rewrite the draft as a clearer prompt.",
  explorer: "You are strictly read-only.",
  "final-response": "Reply with the final answer only. Do not call tools.",
  "max-steps-final": "Give the best final answer from completed work. Do not call tools.",
  reviewer: "You are strictly read-only.",
  system: "You are Wizzle. Broad codebase discovery requires Explorer.",
  title: "Return a concise conversation title.",
  worker: "Change only files necessary for the delegated task.",
};

export function createTestRemoteConfig(
  promptOverrides: Partial<Record<RemotePromptId, string>> = {},
): RemoteConfig {
  return {
    developer: {
      email: "developer@example.test",
      links: [{ id: "site", label: "Website", url: "https://example.test/" }],
      name: "Example Developer",
    },
    prompts: { ...prompts, ...promptOverrides },
    providers: [],
    revision: "test",
    sourceUrl: "https://example.test/app-config.yaml",
    update: {
      note: "Test release",
      platform: "macos",
      status: "normal",
      url: "https://example.test/releases",
      version: "0.0.0",
    },
    usingCachedConfig: false,
  };
}
