import { invoke } from "@tauri-apps/api/core";
import { clientEnv } from "./env";

type FrontendLogLevel = "error" | "info" | "debug";

type FrontendLogEntry = {
  data?: unknown;
  event: string;
  level: FrontendLogLevel;
  scope: string;
  timestampMs: number;
};

type FrontendLogMode = "off" | "error" | "info" | "debug";

const FLUSH_INTERVAL_MS = 500;
const MAX_BATCH_SIZE = 50;
const FRONTEND_LOG_MODE = parseMode(clientEnv.WIZZLE_FRONTEND_LOG_MODE);
const FRONTEND_LOG_RETENTION_DAYS = parseRetentionDays(
  clientEnv.WIZZLE_FRONTEND_LOG_RETENTION_DAYS,
);

let flushTimerId: number | null = null;
let pendingEntries: FrontendLogEntry[] = [];
let isFlushing = false;

function parseMode(rawValue: string | undefined): FrontendLogMode {
  switch ((rawValue ?? "debug").trim().toLowerCase()) {
    case "off":
    case "error":
    case "info":
    case "debug":
      return rawValue!.trim().toLowerCase() as FrontendLogMode;
    default:
      return "debug";
  }
}

function parseRetentionDays(rawValue: string | undefined) {
  const parsedValue = Number.parseInt(rawValue ?? "7", 10);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 7;
}

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return {
      hash: hashString(value),
      length: value.length,
      type: "string",
    };
  }

  if (depth >= 3) {
    return {
      type: Array.isArray(value) ? "array" : "object",
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map((entry) => sanitizeForLog(entry, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).slice(0, 24).map(([key, entryValue]) => [
      key,
      sanitizeForLog(entryValue, depth + 1),
    ]),
  );
}

function shouldLog(level: FrontendLogLevel) {
  if (FRONTEND_LOG_MODE === "off") {
    return false;
  }

  if (FRONTEND_LOG_MODE === "error") {
    return level === "error";
  }

  if (FRONTEND_LOG_MODE === "info") {
    return level !== "debug";
  }

  return true;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function flushEntries() {
  if (isFlushing || pendingEntries.length === 0 || !isTauriRuntime()) {
    return;
  }

  isFlushing = true;
  const nextEntries = pendingEntries.slice(0, MAX_BATCH_SIZE);
  pendingEntries = pendingEntries.slice(MAX_BATCH_SIZE);

  try {
    await invoke("write_frontend_logs", {
      input: {
        entries: nextEntries,
        retentionDays: FRONTEND_LOG_RETENTION_DAYS,
      },
    });
  } catch {
    // Logging failures should never affect the UI flow.
  } finally {
    isFlushing = false;

    if (pendingEntries.length > 0) {
      scheduleFlush(0);
    }
  }
}

function scheduleFlush(delay = FLUSH_INTERVAL_MS) {
  if (flushTimerId !== null) {
    return;
  }

  flushTimerId = window.setTimeout(() => {
    flushTimerId = null;
    void flushEntries();
  }, delay);
}

function enqueue(entry: FrontendLogEntry) {
  pendingEntries.push(entry);

  if (entry.level === "error" || pendingEntries.length >= MAX_BATCH_SIZE) {
    scheduleFlush(0);
    return;
  }

  scheduleFlush();
}

function log(level: FrontendLogLevel, scope: string, event: string, data?: unknown) {
  if (!shouldLog(level)) {
    return;
  }

  enqueue({
    data: data === undefined ? undefined : sanitizeForLog(data),
    event,
    level,
    scope,
    timestampMs: Date.now(),
  });
}

export const frontendLogger = {
  debug(scope: string, event: string, data?: unknown) {
    log("debug", scope, event, data);
  },
  error(scope: string, event: string, data?: unknown) {
    log("error", scope, event, data);
  },
  info(scope: string, event: string, data?: unknown) {
    log("info", scope, event, data);
  },
};

export function installFrontendLogHandlers() {
  window.addEventListener("error", (event) => {
    frontendLogger.error("frontend.runtime", "window_error", {
      column: event.colno,
      fileName: event.filename,
      line: event.lineno,
      message: event.message,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    frontendLogger.error("frontend.runtime", "unhandled_rejection", {
      reason: event.reason,
    });
  });

  window.addEventListener("beforeunload", () => {
    void flushEntries();
  });

  frontendLogger.info("frontend.runtime", "logging_ready", {
    mode: FRONTEND_LOG_MODE,
    retentionDays: FRONTEND_LOG_RETENTION_DAYS,
  });
}
