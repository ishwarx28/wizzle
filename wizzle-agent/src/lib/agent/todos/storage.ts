import { invoke } from "@tauri-apps/api/core";

import type { TodoState } from "./types";

type StoredTodoState = { stateJson: string };

function isTodoState(value: unknown): value is TodoState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TodoState>;
  return state.version === 1 &&
    typeof state.type === "string" &&
    typeof state.createdAtMs === "number" &&
    typeof state.updatedAtMs === "number" &&
    Array.isArray(state.items) &&
    state.items.every((item) =>
      Boolean(item) &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.addedByTemplate === "boolean" &&
      ["cancelled", "completed", "in_progress", "pending"].includes(item.status),
    );
}

export async function loadTodoState(sessionId: string) {
  const stored = await invoke<StoredTodoState | null>("load_todo_state", { input: { sessionId } });
  if (!stored) return null;
  try {
    const state: unknown = JSON.parse(stored.stateJson);
    if (!isTodoState(state)) throw new Error("invalid TODO state");
    return state;
  } catch {
    throw new Error("Saved session TODO could not be read.");
  }
}

export async function saveTodoState(sessionId: string, state: TodoState | null) {
  await invoke("save_todo_state", {
    input: {
      sessionId,
      stateJson: JSON.stringify(state),
      updatedAtMs: Date.now(),
    },
  });
  publishTodoState(sessionId, state);
}

const listeners = new Set<(sessionId: string, state: TodoState | null) => void>();

export function publishTodoState(sessionId: string, state: TodoState | null) {
  listeners.forEach((listener) => listener(sessionId, state));
}

export function subscribeTodoState(listener: (sessionId: string, state: TodoState | null) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
