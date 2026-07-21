import { parseImplementationPlanMarkdown } from "./parser";
import type {
  ImplementationPlanState,
  ImplementationPlanStep,
  ImplementationPlanToolInput,
  ImplementationPlanToolResult,
  ImplementationPlanToolStep,
} from "./types";

type IdFactory = () => string;

function clone(state: ImplementationPlanState): ImplementationPlanState {
  return JSON.parse(JSON.stringify(state)) as ImplementationPlanState;
}

function currentStep(state: ImplementationPlanState | null) {
  return state?.steps.find((step) => step.status === "in_progress");
}

function compactStep(step: ImplementationPlanStep): ImplementationPlanToolStep {
  return { kind: step.kind, status: step.status, title: step.title };
}

function result(
  state: ImplementationPlanState,
  note: string,
  stopTurn = false,
): ImplementationPlanToolResult {
  const active = currentStep(state);
  return {
    currentStep: active ? compactStep(active) : undefined,
    note,
    ok: true,
    path: state.planPath,
    status: state.status,
    steps: state.steps.map(compactStep),
    stopTurn,
  };
}

function buildPlan(
  input: ImplementationPlanToolInput,
  planPath: string,
  now: number,
  idFactory: IdFactory,
) {
  const parsed = parseImplementationPlanMarkdown(input.markdown);
  const approaches = parsed.approaches.map((approach) => ({
    id: `approach-${idFactory()}`,
    summary: approach,
    title: approach,
    tradeoffs: [],
  }));
  return {
    affectedFiles: parsed.affectedFiles,
    approaches,
    concerns: [],
    createdAtMs: now,
    findings: [],
    gaps: [],
    goal: parsed.goal,
    intendedFix: parsed.intendedFix,
    markdown: parsed.markdown,
    planPath,
    recommendedApproachId: approaches[0]!.id,
    rootCause: parsed.rootCause,
    status: "awaiting_user" as const,
    steps: parsed.steps.map((step) => ({
      details: step.title,
      id: `plan-step-${idFactory()}`,
      kind: step.kind,
      status: "pending" as const,
      title: step.title,
    })),
    summary: parsed.goal,
    taskType: parsed.rootCause ? "bug_fix" as const : "other" as const,
    title: parsed.title,
    updatedAtMs: now,
    version: 1 as const,
  } satisfies ImplementationPlanState;
}

export function createImplementationPlanEngine(
  initialState: ImplementationPlanState | null,
  planPath: string,
  options: { idFactory?: IdFactory; now?: () => number } = {},
) {
  let state = initialState ? clone(initialState) : null;
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => Date.now());

  function requireState() {
    if (!state) throw new Error("This session has no implementation plan. Save one first.");
    return state;
  }

  function save(input: ImplementationPlanToolInput) {
    const previous = state;
    const revising = Boolean(previous && previous.status !== "completed");
    const next = buildPlan(input, planPath, now(), idFactory);
    if (revising && previous) next.createdAtMs = previous.createdAtMs;
    state = next;
    return result(
      state,
      revising
        ? "Implementation plan revised for user review."
        : "Implementation plan saved for user review.",
      true,
    );
  }

  function advance() {
    const current = requireState();
    if (current.status === "completed") {
      throw new Error("The implementation plan is already complete. Save a new plan for new work.");
    }

    const active = currentStep(current);
    if (active) active.status = "completed";
    const next = current.steps.find((step) => step.status === "pending");
    current.updatedAtMs = now();

    if (!next) {
      current.status = "completed";
      state = current;
      return result(current, "Implementation plan completed.");
    }

    if (current.status === "awaiting_user") {
      current.selectedApproachId = current.recommendedApproachId;
      current.status = "in_progress";
    }
    next.status = "in_progress";
    state = current;
    return result(
      current,
      active
        ? `Completed “${active.title}” and started “${next.title}”.`
        : `Started “${next.title}”.`,
    );
  }

  return {
    getContinuationInstruction() {
      if (!state || state.status === "completed") return null;
      if (state.status === "awaiting_user") {
        return `The implementation plan at ${state.planPath} awaits the user's response. If they request changes, save the revised Markdown and stop again. If they say continue or proceed, call implementation_plan advance before mutating the project. If they choose another approach, save a revision with that approach first and aligned steps.`;
      }
      const active = currentStep(state);
      return active
        ? `Work only on the active plan step: ${active.title}. When it is actually complete, call implementation_plan advance to mark it done and start the next step. Do not start different work first.`
        : "Call implementation_plan advance to start the next pending step before doing more project work.";
    },
    getSnapshot() {
      return state ? clone(state) : null;
    },
    hasPendingExecution() {
      return Boolean(state && state.status !== "completed");
    },
    run(input: ImplementationPlanToolInput) {
      switch (input.action) {
        case "save": return save(input);
        case "advance": return advance();
        default: throw new Error("implementation_plan action must be save or advance.");
      }
    },
  };
}

export type ImplementationPlanEngine = ReturnType<typeof createImplementationPlanEngine>;
