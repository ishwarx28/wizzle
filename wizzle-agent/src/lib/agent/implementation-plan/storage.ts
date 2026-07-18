import { invoke } from "@tauri-apps/api/core";

import { renderImplementationPlanMarkdown } from "./markdown";
import type { ImplementationPlanState } from "./types";

type StoredImplementationPlanState = {
  planPath: string;
  stateJson: string;
};

function isImplementationPlanState(value: unknown): value is ImplementationPlanState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ImplementationPlanState>;
  return state.version === 1 &&
    ["awaiting_user", "completed", "in_progress"].includes(String(state.status)) &&
    typeof state.title === "string" &&
    typeof state.goal === "string" &&
    typeof state.planPath === "string" &&
    typeof state.createdAtMs === "number" &&
    typeof state.updatedAtMs === "number" &&
    Array.isArray(state.approaches) &&
    state.approaches.length >= 1 &&
    state.approaches.length <= 3 &&
    Array.isArray(state.steps) &&
    state.steps.every((step) =>
      Boolean(step) &&
      typeof step.id === "string" &&
      typeof step.title === "string" &&
      typeof step.details === "string" &&
      ["implementation", "verification"].includes(step.kind) &&
      ["completed", "in_progress", "pending"].includes(step.status),
    );
}

export async function loadImplementationPlanState(sessionId: string) {
  const stored = await invoke<StoredImplementationPlanState | null>(
    "load_implementation_plan_state",
    { input: { sessionId } },
  );
  if (!stored) return null;
  try {
    const state: unknown = JSON.parse(stored.stateJson);
    if (!isImplementationPlanState(state)) throw new Error("invalid implementation plan state");
    return { ...state, planPath: stored.planPath };
  } catch {
    throw new Error("The saved implementation plan could not be read.");
  }
}

export async function saveImplementationPlanState(
  sessionId: string,
  state: ImplementationPlanState,
) {
  const saved = await invoke<{ planPath: string }>("save_implementation_plan_state", {
    input: {
      planMarkdown: renderImplementationPlanMarkdown(state),
      sessionId,
      stateJson: JSON.stringify(state),
      updatedAtMs: state.updatedAtMs,
    },
  });
  const savedState = { ...state, planPath: saved.planPath };
  publishImplementationPlanState(sessionId, savedState);
  return savedState;
}

const listeners = new Set<(
  sessionId: string,
  state: ImplementationPlanState | null,
) => void>();

export function publishImplementationPlanState(
  sessionId: string,
  state: ImplementationPlanState | null,
) {
  listeners.forEach((listener) => listener(sessionId, state));
}

export function subscribeImplementationPlanState(
  listener: (sessionId: string, state: ImplementationPlanState | null) => void,
) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
