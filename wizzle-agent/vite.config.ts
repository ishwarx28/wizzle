import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function resolveClientEnv(mode: string) {
  const loadedEnv = loadEnv(mode, process.cwd(), "");

  return {
    WIZZLE_COMPACTED_CONTEXT_TOKENS:
      loadedEnv.WIZZLE_COMPACTED_CONTEXT_TOKENS?.trim() ??
      loadedEnv.VITE_WIZZLE_COMPACTED_CONTEXT_TOKENS?.trim(),
    WIZZLE_MAX_AGENT_STEPS: loadedEnv.VITE_WIZZLE_MAX_AGENT_STEPS?.trim(),
    WIZZLE_MAX_PROMPT_SIZE: loadedEnv.VITE_WIZZLE_MAX_PROMPT_SIZE?.trim(),
    WIZZLE_OUTPUT_RESERVED_PERCENT:
      loadedEnv.WIZZLE_OUTPUT_RESERVED_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_OUTPUT_RESERVED_PERCENT?.trim(),
    WIZZLE_HEALTHY_CONTEXT_PERCENT:
      loadedEnv.WIZZLE_HEALTHY_CONTEXT_PERCENT?.trim() ??
      loadedEnv.VITE_WIZZLE_HEALTHY_CONTEXT_PERCENT?.trim(),
    WIZZLE_FRONTEND_LOG_MODE: loadedEnv.VITE_WIZZLE_FRONTEND_LOG_MODE?.trim(),
    WIZZLE_FRONTEND_LOG_RETENTION_DAYS:
      loadedEnv.VITE_WIZZLE_FRONTEND_LOG_RETENTION_DAYS?.trim(),
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [tailwindcss(), react(), wasm(), topLevelAwait()],
  envPrefix: "WIZZLE_PUBLIC_",
  define: {
    __WIZZLE_ENV__: JSON.stringify(resolveClientEnv(mode)),
  },
  build: {
    chunkSizeWarningLimit: 1250,
    sourcemap: false,
    target: "esnext",
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
