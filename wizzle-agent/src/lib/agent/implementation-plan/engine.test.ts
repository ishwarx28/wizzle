import { createImplementationPlanEngine } from "./engine.ts";
import { renderImplementationPlanMarkdown } from "./markdown.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function planInput() {
  return {
    action: "create" as const,
    affectedFiles: [{ path: "src/app.ts", reason: "Controls the changed behavior." }],
    approaches: [
      {
        summary: "Change the controlling implementation directly.",
        title: "Direct integration",
        tradeoffs: ["Smallest change"],
      },
      {
        summary: "Introduce an abstraction before changing behavior.",
        title: "New abstraction",
        tradeoffs: ["More reusable", "Larger change"],
      },
    ],
    concerns: ["Preserve persisted sessions."],
    findings: ["The existing behavior is controlled in src/app.ts."],
    gaps: [],
    goal: "Implement the requested behavior safely.",
    implementationSteps: [
      { details: "Update the controlling branch.", title: "Implement the behavior" },
      { details: "Update the user-facing integration.", title: "Wire the UI" },
    ],
    recommendedApproach: 0,
    summary: "Use the existing integration point and preserve compatibility.",
    taskType: "implementation" as const,
    title: "Implementation plan",
    verificationSteps: [
      { details: "Run the focused test and typecheck.", title: "Verify the implementation" },
    ],
  };
}

function main() {
  let id = 0;
  let time = 100;
  const engine = createImplementationPlanEngine(null, "/tmp/implementation-plan.md", {
    idFactory: () => String(++id),
    now: () => ++time,
  });
  const created = engine.run(planInput());
  assert(created.stopTurn, "creating a plan stops the turn for user review");
  assert(created.status === "awaiting_user", "new plans await user review");
  assert(created.approaches.length === 2, "plans retain one to three approaches");
  assert(engine.hasPendingExecution(), "an unapproved plan remains pending");

  const resumed = engine.run({
    action: "resume",
    approachId: created.recommendedApproachId,
  });
  assert(resumed.status === "in_progress", "approved plans enter execution");

  const firstStep = resumed.steps[0]!;
  engine.run({ action: "start_step", stepId: firstStep.id });
  let skippedStepFailed = false;
  try {
    engine.run({ action: "start_step", stepId: resumed.steps[1]!.id });
  } catch {
    skippedStepFailed = true;
  }
  assert(skippedStepFailed, "the next step cannot start before the current step is complete");

  engine.run({ action: "complete_step", stepId: firstStep.id });
  for (const step of resumed.steps.slice(1)) {
    engine.run({ action: "start_step", stepId: step.id });
    engine.run({ action: "complete_step", stepId: step.id });
  }
  const completed = engine.run({ action: "status" });
  assert(completed.status === "completed", "verification completion finishes the plan");
  assert(!engine.hasPendingExecution(), "completed plans release final-answer enforcement");

  const markdown = renderImplementationPlanMarkdown(completed);
  assert(markdown.includes("## Approaches"), "artifact includes approaches");
  assert(markdown.includes("## Affected files"), "artifact includes affected files");
  assert(markdown.includes("## Verification steps"), "artifact ends with verification details");
  assert(markdown.includes("- [x]"), "completed steps are marked in Markdown");

  const bugEngine = createImplementationPlanEngine(null, "/tmp/bug-plan.md");
  let missingRootCauseFailed = false;
  try {
    bugEngine.run({ ...planInput(), taskType: "bug_fix" });
  } catch {
    missingRootCauseFailed = true;
  }
  assert(missingRootCauseFailed, "bug plans require root cause and intended fix");

  console.log("implementation plan engine tests passed");
}

main();
