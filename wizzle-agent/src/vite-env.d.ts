/// <reference types="vite/client" />

type WizzleClientEnv = {
  readonly WIZZLE_COMPACTED_CONTEXT_TOKENS?: string;
  readonly WIZZLE_MAX_AGENT_STEPS?: string;
  readonly WIZZLE_MAX_PROMPT_SIZE?: string;
  readonly WIZZLE_OUTPUT_RESERVED_PERCENT?: string;
  readonly WIZZLE_HEALTHY_CONTEXT_PERCENT?: string;
  readonly WIZZLE_FRONTEND_LOG_MODE?: string;
  readonly WIZZLE_FRONTEND_LOG_RETENTION_DAYS?: string;
};

declare const __WIZZLE_ENV__: WizzleClientEnv;

interface ImportMetaEnv {
  readonly WIZZLE_PUBLIC_SAMPLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
