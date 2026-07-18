import type {
  ImplementationPlanAffectedFile,
  ImplementationPlanApproach,
  ImplementationPlanState,
  ImplementationPlanStep,
  ImplementationPlanTaskType,
  ImplementationPlanToolInput,
  ImplementationPlanToolResult,
} from "./types";

type IdFactory = () => string;

function meaningfulText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} requires meaningful text.`);
  }
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textList(value: unknown, field: string, maximum: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${field} must contain at most ${maximum} entries.`);
  }
  return value.map((item, index) => meaningfulText(item, `${field} ${index + 1}`));
}

function clone(state: ImplementationPlanState): ImplementationPlanState {
  return JSON.parse(JSON.stringify(state)) as ImplementationPlanState;
}

function taskType(value: unknown): ImplementationPlanTaskType {
  const allowed: ImplementationPlanTaskType[] = [
    "bug_fix",
    "debugging",
    "implementation",
    "new_project",
    "review",
    "other",
  ];
  if (!allowed.includes(value as ImplementationPlanTaskType)) {
    throw new Error(`taskType must be one of: ${allowed.join(", ")}.`);
  }
  return value as ImplementationPlanTaskType;
}

function approaches(value: unknown, idFactory: IdFactory) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error("An implementation plan requires one to three approaches.");
  }
  return value.map((entry, index): ImplementationPlanApproach => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Approach ${index + 1} must be an object.`);
    }
    const input = entry as Record<string, unknown>;
    const tradeoffs = textList(input.tradeoffs, `Approach ${index + 1} tradeoffs`, 8);
    if (tradeoffs.length < 1) {
      throw new Error(`Approach ${index + 1} requires at least one tradeoff.`);
    }
    return {
      id: `approach-${idFactory()}`,
      summary: meaningfulText(input.summary, `Approach ${index + 1} summary`),
      title: meaningfulText(input.title, `Approach ${index + 1} title`),
      tradeoffs,
    };
  });
}

function affectedFiles(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("An implementation plan requires one to one hundred affected files.");
  }
  return value.map((entry, index): ImplementationPlanAffectedFile => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Affected file ${index + 1} must be an object.`);
    }
    const input = entry as Record<string, unknown>;
    return {
      path: meaningfulText(input.path, `Affected file ${index + 1} path`),
      reason: meaningfulText(input.reason, `Affected file ${index + 1} reason`),
    };
  });
}

function steps(
  value: unknown,
  field: string,
  kind: ImplementationPlanStep["kind"],
  idFactory: IdFactory,
  maximum: number,
) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${field} requires one to ${maximum} ordered entries.`);
  }
  return value.map((entry, index): ImplementationPlanStep => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${field} ${index + 1} must be an object.`);
    }
    const input = entry as Record<string, unknown>;
    return {
      details: meaningfulText(input.details, `${field} ${index + 1} details`),
      id: `plan-step-${idFactory()}`,
      kind,
      status: "pending",
      title: meaningfulText(input.title, `${field} ${index + 1} title`),
    };
  });
}

function buildPlan(
  input: ImplementationPlanToolInput,
  planPath: string,
  now: number,
  idFactory: IdFactory,
) {
  const resolvedTaskType = taskType(input.taskType);
  const resolvedApproaches = approaches(input.approaches, idFactory);
  const recommendedApproach = input.recommendedApproach;
  if (
    !Number.isInteger(recommendedApproach) ||
    (recommendedApproach as number) < 0 ||
    (recommendedApproach as number) >= resolvedApproaches.length
  ) {
    throw new Error("recommendedApproach must be a zero-based index into approaches.");
  }
  const rootCause = optionalText(input.rootCause);
  const intendedFix = optionalText(input.intendedFix);
  if (["bug_fix", "debugging"].includes(resolvedTaskType) && (!rootCause || !intendedFix)) {
    throw new Error("Bug-fix and debugging plans require both rootCause and intendedFix.");
  }
  const findings = textList(input.findings, "Findings", 50);
  if (findings.length < 1) {
    throw new Error("An implementation plan requires at least one inspection finding.");
  }
  return {
    affectedFiles: affectedFiles(input.affectedFiles),
    approaches: resolvedApproaches,
    concerns: textList(input.concerns, "Concerns", 30),
    createdAtMs: now,
    findings,
    gaps: textList(input.gaps, "Gaps", 30),
    goal: meaningfulText(input.goal, "Plan goal"),
    intendedFix,
    planPath,
    recommendedApproachId: resolvedApproaches[recommendedApproach as number]!.id,
    rootCause,
    status: "awaiting_user" as const,
    steps: [
      ...steps(input.implementationSteps, "Implementation steps", "implementation", idFactory, 30),
      ...steps(input.verificationSteps, "Verification steps", "verification", idFactory, 10),
    ],
    summary: meaningfulText(input.summary, "Plan summary"),
    taskType: resolvedTaskType,
    title: meaningfulText(input.title, "Plan title"),
    updatedAtMs: now,
    version: 1 as const,
  } satisfies ImplementationPlanState;
}

function currentStep(state: ImplementationPlanState | null) {
  return state?.steps.find((step) => step.status === "in_progress");
}

function result(state: ImplementationPlanState, note: string, stopTurn = false): ImplementationPlanToolResult {
  return {
    ...clone(state),
    currentStep: currentStep(state),
    note,
    ok: true,
    path: state.planPath,
    stopTurn,
  };
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
    if (!state) throw new Error("This session has no implementation plan. Create one first.");
    return state;
  }

  function create(input: ImplementationPlanToolInput) {
    if (state && state.status !== "completed") {
      throw new Error("Revise the current implementation plan instead of creating another one.");
    }
    state = buildPlan(input, planPath, now(), idFactory);
    return result(state, "Implementation plan created for user review.", true);
  }

  function revise(input: ImplementationPlanToolInput) {
    const previous = requireState();
    const revised = buildPlan(input, planPath, now(), idFactory);
    revised.createdAtMs = previous.createdAtMs;
    state = revised;
    return result(state, "Implementation plan revised for user review.", true);
  }

  function resume(input: ImplementationPlanToolInput) {
    const current = requireState();
    if (current.status !== "awaiting_user") {
      throw new Error("Only a plan awaiting user review can be resumed.");
    }
    const approachId = meaningfulText(input.approachId, "approachId");
    if (!current.approaches.some((approach) => approach.id === approachId)) {
      throw new Error("approachId does not exist in this implementation plan.");
    }
    current.selectedApproachId = approachId;
    current.status = "in_progress";
    current.updatedAtMs = now();
    return result(current, "Implementation plan approved for execution.");
  }

  function startStep(input: ImplementationPlanToolInput) {
    const current = requireState();
    if (current.status !== "in_progress") {
      throw new Error("Resume the implementation plan before starting a step.");
    }
    if (currentStep(current)) {
      throw new Error("Complete the current implementation-plan step before starting another.");
    }
    const stepId = meaningfulText(input.stepId, "stepId");
    const step = current.steps.find((entry) => entry.id === stepId);
    if (!step) throw new Error("stepId does not exist in this implementation plan.");
    if (step.status === "completed") throw new Error("That implementation-plan step is already complete.");
    const earliestPending = current.steps.find((entry) => entry.status === "pending");
    if (earliestPending?.id !== stepId) {
      throw new Error("Start implementation-plan steps in order.");
    }
    step.status = "in_progress";
    current.updatedAtMs = now();
    return result(current, "Implementation-plan step started.");
  }

  function completeStep(input: ImplementationPlanToolInput) {
    const current = requireState();
    const stepId = meaningfulText(input.stepId, "stepId");
    const step = current.steps.find((entry) => entry.id === stepId);
    if (!step) throw new Error("stepId does not exist in this implementation plan.");
    if (step.status !== "in_progress") {
      throw new Error("Only the current in-progress implementation-plan step can be completed.");
    }
    step.status = "completed";
    current.updatedAtMs = now();
    if (current.steps.every((entry) => entry.status === "completed")) {
      current.status = "completed";
    }
    return result(
      current,
      current.status === "completed"
        ? "Implementation plan completed."
        : "Implementation-plan step completed. Start the next step before working on it.",
    );
  }

  return {
    getContinuationInstruction() {
      if (!state || state.status === "completed") return null;
      if (state.status === "awaiting_user") {
        return `The implementation plan at ${state.planPath} awaits the user's response. If the user says continue/proceed or selects an approach, call implementation_plan resume before doing project work. If the user requests changes, call implementation_plan revise and stop again. Do not mutate the project while the plan awaits review.`;
      }
      const active = currentStep(state);
      return active
        ? `The implementation plan is active. Work only on step ${active.id}: ${active.title}. Complete it with implementation_plan before starting another step. Do not give a final answer until every implementation and verification step is complete.`
        : "The implementation plan is active. Start the earliest pending step with implementation_plan before doing its work. Complete each step before starting the next, and do not give a final answer until all steps are complete.";
    },
    getSnapshot() {
      return state ? clone(state) : null;
    },
    hasPendingExecution() {
      return Boolean(state && state.status !== "completed");
    },
    run(input: ImplementationPlanToolInput) {
      switch (input.action) {
        case "create": return create(input);
        case "revise": return revise(input);
        case "resume": return resume(input);
        case "start_step": return startStep(input);
        case "complete_step": return completeStep(input);
        case "status": {
          const current = requireState();
          return result(current, "Implementation-plan status loaded.");
        }
        default:
          throw new Error(
            "implementation_plan action must be create, revise, resume, start_step, complete_step, or status.",
          );
      }
    },
  };
}

export type ImplementationPlanEngine = ReturnType<typeof createImplementationPlanEngine>;
