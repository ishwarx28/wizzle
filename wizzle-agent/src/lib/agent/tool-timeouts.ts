export const TOOL_TIMEOUT_OPTIONS = ["15s", "30s", "60s", "120s", "180s"] as const;

export type ToolTimeoutOption = (typeof TOOL_TIMEOUT_OPTIONS)[number];

export const DEFAULT_TOOL_TIMEOUT: ToolTimeoutOption = "30s";

export const TOOL_TIMEOUT_DESCRIPTION =
  "Optional timeout. Defaults to 30s. Increase it for longer builds, tests, or searches.";
