import { createImplementationPlanEngine } from "./engine.ts";
import { renderImplementationPlanMarkdown } from "./markdown.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const PLAN_MARKDOWN = `# Implementation plan

## Goal

Implement the requested behavior safely.

## Approaches

1. Direct integration — smallest compatible change.
2. New abstraction — more reusable but larger.

## Affected files

- src/app.ts — controls the behavior.
- src/app.test.ts — verifies the behavior.

## Steps

- [ ] Implement the behavior
- [ ] Update the integration

## Verification

- [ ] Run the focused test and typecheck
`;

function main() {
  let id = 0;
  let time = 100;
  const engine = createImplementationPlanEngine(null, "/tmp/implementation-plan.md", {
    idFactory: () => String(++id),
    now: () => ++time,
  });
  const saved = engine.run({ action: "save", markdown: PLAN_MARKDOWN });
  assert(saved.stopTurn, "saving a plan stops the turn for user review");
  assert(saved.status === "awaiting_user", "saved plans await user review");
  assert(saved.steps.length === 3, "compact results retain ordered implementation and verification steps");
  assert(!("id" in saved.steps[0]!), "model-facing plan results omit workflow IDs");
  assert(!("approaches" in saved), "model-facing plan results omit internal plan structures");
  assert(engine.hasPendingExecution(), "an unapproved plan remains pending");

  const started = engine.run({ action: "advance" });
  assert(started.status === "in_progress", "advance approves the plan and starts its first step");
  assert(started.currentStep?.title === "Implement the behavior", "the first step starts automatically");

  const second = engine.run({ action: "advance" });
  assert(second.steps[0]?.status === "completed", "advance completes the active step first");
  assert(second.currentStep?.title === "Update the integration", "advance starts only the next step");

  engine.run({ action: "advance" });
  const completed = engine.run({ action: "advance" });
  assert(completed.status === "completed", "the final verification advance completes the plan");
  assert(!engine.hasPendingExecution(), "completed plans release final-answer enforcement");

  const snapshot = engine.getSnapshot();
  assert(snapshot, "the completed plan remains available");
  const markdown = renderImplementationPlanMarkdown(snapshot);
  assert(markdown.includes("## Approaches"), "artifact includes approaches");
  assert(markdown.includes("## Affected files"), "artifact includes affected files");
  assert(markdown.includes("## Verification"), "artifact ends with verification details");
  assert(markdown.match(/- \[x\]/g)?.length === 3, "completed steps are checked in Markdown");

  const revisionEngine = createImplementationPlanEngine(null, "/tmp/revision-plan.md");
  revisionEngine.run({ action: "save", markdown: PLAN_MARKDOWN });
  const revised = revisionEngine.run({
    action: "save",
    markdown: PLAN_MARKDOWN.replace("Direct integration", "Focused integration"),
  });
  assert(revised.stopTurn && revised.status === "awaiting_user", "saving again revises and reopens review");

  const bugEngine = createImplementationPlanEngine(null, "/tmp/bug-plan.md");
  let missingFixFailed = false;
  try {
    bugEngine.run({
      action: "save",
      markdown: PLAN_MARKDOWN.replace("## Approaches", "## Root cause\n\nThe failing branch is stale.\n\n## Approaches"),
    });
  } catch {
    missingFixFailed = true;
  }
  assert(missingFixFailed, "bug sections require both root cause and intended fix");

  console.log("implementation plan engine tests passed");
}

main();
