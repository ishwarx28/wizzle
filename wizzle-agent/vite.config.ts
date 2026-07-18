import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
function resolveClientEnv(mode: string) {
  const loadedEnv = loadEnv(mode, process.cwd(), "");

  return {
    WIZZLE_ACTIVE_TURN_PRESSURE_PERCENT:
      loadedEnv.WIZZLE_ACTIVE_TURN_PRESSURE_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_ACTIVE_TURN_PRESSURE_PERCENT?.trim(),
    WIZZLE_COMPACTED_CONTEXT_TOKENS:
      loadedEnv.WIZZLE_COMPACTED_CONTEXT_TOKENS?.trim() ??
      loadedEnv.VITE_WIZZLE_COMPACTED_CONTEXT_TOKENS?.trim(),
    WIZZLE_COMPACTION_TRIGGER_PERCENT:
      loadedEnv.WIZZLE_COMPACTION_TRIGGER_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_COMPACTION_TRIGGER_PERCENT?.trim(),
    WIZZLE_CONTEXT_SAFETY_PERCENT:
      loadedEnv.WIZZLE_CONTEXT_SAFETY_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_CONTEXT_SAFETY_PERCENT?.trim(),
    WIZZLE_MAX_AGENT_STEPS: loadedEnv.VITE_WIZZLE_MAX_AGENT_STEPS?.trim(),
    WIZZLE_MAX_PROMPT_SIZE: loadedEnv.VITE_WIZZLE_MAX_PROMPT_SIZE?.trim(),
    WIZZLE_OUTPUT_RESERVED_PERCENT:
      loadedEnv.WIZZLE_OUTPUT_RESERVED_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_OUTPUT_RESERVED_PERCENT?.trim(),
    WIZZLE_POST_COMPACTION_TARGET_PERCENT:
      loadedEnv.WIZZLE_POST_COMPACTION_TARGET_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_POST_COMPACTION_TARGET_PERCENT?.trim(),
    WIZZLE_HEALTHY_CONTEXT_PERCENT:
      loadedEnv.WIZZLE_HEALTHY_CONTEXT_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_HEALTHY_CONTEXT_PERCENT?.trim(),
    WIZZLE_FRONTEND_LOG_MODE: loadedEnv.VITE_WIZZLE_FRONTEND_LOG_MODE?.trim(),
    WIZZLE_FRONTEND_LOG_RETENTION_DAYS:
      loadedEnv.VITE_WIZZLE_FRONTEND_LOG_RETENTION_DAYS?.trim(),
    WIZZLE_CONFIG_URL: loadedEnv.WIZZLE_CONFIG_URL?.trim(),
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [tailwindcss(), react()],
  base: "./",
  envPrefix: "WIZZLE_PUBLIC_",
  define: {
    __WIZZLE_ENV__: JSON.stringify(resolveClientEnv(mode)),
  },
  build: {
    chunkSizeWarningLimit: 1250,
    sourcemap: false,
    target: "chrome105",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
