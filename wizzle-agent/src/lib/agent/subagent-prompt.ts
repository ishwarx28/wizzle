export function buildSubagentTaskPrompt(options: {
  isContinuation: boolean;
  parentRequest: string;
  task: string;
}) {
  const sections = options.parentRequest.trim()
    ? [
        "Parent user request (its constraints are binding):",
        options.parentRequest.trim(),
        "",
        "Delegated task:",
        options.task.trim(),
      ]
    : [options.task.trim()];

  if (options.isContinuation) {
    sections.push(
      "",
      "Return a self-contained consolidated result. Include relevant prior findings; do not refer to an earlier response.",
    );
  }

  return sections.join("\n");
}
