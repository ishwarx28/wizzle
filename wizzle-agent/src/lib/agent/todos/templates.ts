type TemplateItem = { position: "before_work" | "after_work" | "end"; title: string };

const templates: Record<string, TemplateItem[]> = {
  creating_project: [
    { position: "before_work", title: "Inspect the workspace and instructions" },
    { position: "before_work", title: "Resolve material product and technical decisions" },
    { position: "before_work", title: "Define acceptance and project quality requirements" },
    { position: "after_work", title: "Run relevant build, lint, typecheck, tests, and runtime checks" },
    { position: "end", title: "Review the completed project against the request" },
  ],
  fixing_bugs: [
    { position: "before_work", title: "Reproduce or trace the failing behavior" },
    { position: "before_work", title: "Identify the concrete root cause" },
    { position: "after_work", title: "Run focused regression and relevant project checks" },
  ],
  adding_features: [
    { position: "before_work", title: "Inspect integration points and clarify behavior" },
    { position: "after_work", title: "Add or update focused behavioral coverage" },
    { position: "end", title: "Run relevant project checks and review the feature" },
  ],
};

const aliases: Record<string, string> = {
  adding_feature: "adding_features",
  create_project: "creating_project",
  creating_projects: "creating_project",
  fix_bug: "fixing_bugs",
  fixing_bug: "fixing_bugs",
  implement_feature: "adding_features",
};

function words(value: string) {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((word) => word.length > 3));
}

function overlaps(left: string, right: string) {
  const leftWords = words(left);
  const rightWords = words(right);
  return [...leftWords].some((word) => rightWords.has(word));
}

export function enrichTodoItems(type: string, requestedItems: string[]) {
  const normalizedType = aliases[type] ?? type;
  const template = templates[normalizedType];
  if (!template) return { added: [] as string[], items: requestedItems, type: normalizedType };

  const added = template.filter((entry) => !requestedItems.some((item) => overlaps(item, entry.title)));
  const before = added.filter((entry) => entry.position === "before_work").map((entry) => entry.title);
  const after = added.filter((entry) => entry.position === "after_work").map((entry) => entry.title);
  const end = added.filter((entry) => entry.position === "end").map((entry) => entry.title);
  return {
    added: added.map((entry) => entry.title),
    items: [...before, ...requestedItems, ...after, ...end],
    type: normalizedType,
  };
}
