import { invoke } from "@tauri-apps/api/core";

import { clientEnv } from "./env";
import type { RemoteConfig, RemotePromptId } from "../types/remote-config";

let activeConfig: RemoteConfig | null = null;

function configuredUrl() {
  const url = clientEnv.WIZZLE_CONFIG_URL?.trim() ?? "";
  if (!url) {
    throw new Error("WIZZLE_CONFIG_URL is not configured for this build.");
  }
  return url;
}

export async function loadRemoteConfig() {
  const config = await invoke<RemoteConfig>("load_remote_config", {
    input: { url: configuredUrl() },
  });
  activeConfig = config;
  return config;
}

export function getRemoteConfig() {
  if (!activeConfig) {
    throw new Error("Wizzle remote configuration is not loaded.");
  }
  return activeConfig;
}

export function getRemotePrompt(id: RemotePromptId) {
  const prompt = getRemoteConfig().prompts[id]?.trim();
  if (!prompt) {
    throw new Error(`Wizzle remote configuration is missing the ${id} prompt.`);
  }
  return prompt;
}

export function installRemoteConfigForTests(config: RemoteConfig) {
  activeConfig = config;
}
