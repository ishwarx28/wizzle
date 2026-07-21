import type {
  ImplementationPlanApproach,
  ImplementationPlanState,
  ImplementationPlanStep,
} from "./types";

function list(items: string[], empty = "None identified.") {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function escapeTableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function approachLabel(state: ImplementationPlanState, approach: ImplementationPlanApproach) {
  const labels = [
    approach.id === state.recommendedApproachId ? "recommended" : null,
    approach.id === state.selectedApproachId ? "selected" : null,
  ].filter(Boolean);
  return labels.length > 0 ? ` (${labels.join(", ")})` : "";
}

function renderApproaches(state: ImplementationPlanState) {
  return state.approaches
    .map(
      (approach, index) => [
        `### ${index + 1}. ${approach.title}${approachLabel(state, approach)}`,
        "",
        approach.summary,
        "",
        "Tradeoffs:",
        list(approach.tradeoffs),
      ].join("\n"),
    )
    .join("\n\n");
}

function renderStep(step: ImplementationPlanStep, index: number) {
  const checked = step.status === "completed" ? "x" : " ";
  const active = step.status === "in_progress" ? " — in progress" : "";
  return [`- [${checked}] ${index + 1}. ${step.title}${active}`, `  - ${step.details}`].join("\n");
}

function renderSteps(steps: ImplementationPlanStep[]) {
  return steps.map(renderStep).join("\n");
}

function statusLabel(status: ImplementationPlanState["status"]) {
  if (status === "awaiting_user") return "Awaiting user review";
  if (status === "in_progress") return "In progress";
  return "Completed";
}

function renderSavedMarkdown(state: ImplementationPlanState) {
  const stepsByKind = {
    implementation: state.steps.filter((step) => step.kind === "implementation"),
    verification: state.steps.filter((step) => step.kind === "verification"),
  };
  const indexes = { implementation: 0, verification: 0 };
  let activeKind: ImplementationPlanStep["kind"] | null = null;
  const rendered: string[] = [];

  for (const line of state.markdown!.trim().split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim().toLowerCase();
    activeKind = heading === "steps"
      ? "implementation"
      : heading === "verification"
        ? "verification"
        : heading
          ? null
          : activeKind;
    const checkbox = /^(\s*)-\s*\[[ xX]\]\s+(.+?)\s*$/.exec(line);
    if (!activeKind || !checkbox) {
      rendered.push(line);
      continue;
    }

    const step = stepsByKind[activeKind][indexes[activeKind]++];
    if (!step) {
      rendered.push(line);
      continue;
    }
    const checked = step.status === "completed" ? "x" : " ";
    const active = step.status === "in_progress" ? " — in progress" : "";
    rendered.push(`${checkbox[1]}- [${checked}] ${step.title}${active}`);
  }

  const titleIndex = rendered.findIndex((line) => /^#\s+/.test(line));
  rendered.splice(titleIndex + 1, 0, "", `**Status:** ${statusLabel(state.status)}`);
  return `${rendered.join("\n").trim()}\n`;
}

export function renderImplementationPlanMarkdown(state: ImplementationPlanState) {
  if (state.markdown) return renderSavedMarkdown(state);

  const implementationSteps = state.steps.filter((step) => step.kind === "implementation");
  const verificationSteps = state.steps.filter((step) => step.kind === "verification");
  const affectedFiles = state.affectedFiles
    .map((file) => `| ${escapeTableCell(file.path)} | ${escapeTableCell(file.reason)} |`)
    .join("\n");
  const rootCauseSection = state.rootCause
    ? [
        "## Root cause",
        "",
        state.rootCause,
        "",
        "## Intended fix",
        "",
        state.intendedFix ?? "Not specified.",
        "",
      ]
    : [];

  return [
    `# ${state.title}`,
    "",
    `**Status:** ${statusLabel(state.status)}`,
    `**Task type:** ${state.taskType}`,
    "",
    "## Goal",
    "",
    state.goal,
    "",
    "## Summary",
    "",
    state.summary,
    "",
    "## Findings",
    "",
    list(state.findings),
    "",
    ...rootCauseSection,
    "## Approaches",
    "",
    renderApproaches(state),
    "",
    "## Affected files",
    "",
    "| File | Reason |",
    "| --- | --- |",
    affectedFiles,
    "",
    "## Concerns",
    "",
    list(state.concerns),
    "",
    "## Gaps",
    "",
    list(state.gaps),
    "",
    "## Implementation steps",
    "",
    renderSteps(implementationSteps),
    "",
    "## Verification steps",
    "",
    renderSteps(verificationSteps),
    "",
    "> Execution rule: mark the current step complete before starting the next step.",
    "",
  ].join("\n");
}
