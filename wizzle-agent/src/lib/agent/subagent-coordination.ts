import type { SubagentSnapshot } from "./subagent-manager";

export function buildSubagentCoordinationMessage(tasks: SubagentSnapshot[]) {
  if (tasks.length === 0) {
    return "";
  }

  const sections = tasks.map(
    (task) => `${task.name} (${task.join}, ${task.status}, ${task.taskId})\nTask: ${task.task}`,
  );

  return [
    "Active subagent tasks:",
    ...sections,
    "Never duplicate an active task. Collaborate by doing other clearly separate work when it exists. If no separate work remains or a required result blocks progress, call wait with a minute-scale duration. Completion ends wait immediately and injects the response. A timeout is not failure: wait again unless the task is genuinely no longer needed. Never interrupt merely because it is slow.",
  ].join("\n\n");
}
