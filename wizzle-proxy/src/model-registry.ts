import type { AppConfig } from "./types.js";

export function createAppConfig(options: {
  wizzle1ThinkingUpstreamModel: string;
}): AppConfig {
  return {
    defaultModel: "wizzle-1-thinking",
    models: {
      "wizzle-1-thinking": {
        id: "wizzle-1-thinking",
        upstream: {
          path: "/v1/chat/completions",
          model: options.wizzle1ThinkingUpstreamModel
        },
        reasoningMap: {
          balanced: "medium",
          max: "max"
        }
      }
    }
  };
}
