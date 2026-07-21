import type { ImplementationPlanAffectedFile, ImplementationPlanStep } from "./types";

const MAX_MARKDOWN_LENGTH = 20_000;
const REQUIRED_SECTIONS = ["goal", "approaches", "affected files", "steps", "verification"] as const;

type ParsedImplementationPlanMarkdown = {
  affectedFiles: ImplementationPlanAffectedFile[];
  approaches: string[];
  goal: string;
  intendedFix?: string;
  markdown: string;
  rootCause?: string;
  steps: Array<Pick<ImplementationPlanStep, "kind" | "title">>;
  title: string;
};

function meaningful(value: string | undefined, label: string) {
  const resolved = value?.trim();
  if (!resolved) throw new Error(`${label} requires meaningful text.`);
  return resolved;
}

function sectionName(line: string) {
  const match = /^##\s+(.+?)\s*$/.exec(line);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

function splitSections(lines: string[]) {
  const sections = new Map<string, string[]>();
  let activeSection: string | null = null;
  for (const line of lines) {
    const heading = sectionName(line);
    if (heading) {
      if (sections.has(heading)) throw new Error(`The plan contains duplicate ${heading} sections.`);
      activeSection = heading;
      sections.set(heading, []);
      continue;
    }
    if (activeSection) sections.get(activeSection)?.push(line);
  }
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.has(required)) throw new Error(`The plan requires a ## ${required} section.`);
  }
  return sections;
}

function numberedItems(lines: string[]) {
  return lines.flatMap((line) => {
    const match = /^\s*\d+[.)]\s+(.+?)\s*$/.exec(line);
    return match?.[1] ? [match[1].trim()] : [];
  });
}

function affectedFiles(lines: string[]) {
  return lines.flatMap((line): ImplementationPlanAffectedFile[] => {
    const match = /^\s*[-*]\s+(?!\[[ xX]\])(.+?)\s*$/.exec(line);
    if (!match?.[1]) return [];
    const entry = match[1].trim();
    const separator = /\s+(?:—|–|-)\s+/.exec(entry);
    if (!separator || separator.index === undefined) {
      return [{ path: entry, reason: "Affected by this plan." }];
    }
    return [{
      path: meaningful(entry.slice(0, separator.index), "Affected file path"),
      reason: meaningful(entry.slice(separator.index + separator[0].length), "Affected file reason"),
    }];
  });
}

function checklist(lines: string[], kind: ImplementationPlanStep["kind"]) {
  return lines.flatMap((line): Array<Pick<ImplementationPlanStep, "kind" | "title">> => {
    const match = /^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/.exec(line);
    if (!match?.[1]) return [];
    return [{
      kind,
      title: match[1].replace(/\s+—\s+in progress$/i, "").trim(),
    }];
  });
}

function normalizeMarkdown(lines: string[]) {
  let activeSection: string | null = null;
  return lines
    .filter((line) => !/^\*\*Status:\*\*/i.test(line.trim()))
    .map((line) => {
      activeSection = sectionName(line) ?? activeSection;
      if (activeSection !== "steps" && activeSection !== "verification") return line;
      return line
        .replace(/^(\s*-\s*)\[[ xX]\](\s+)/, "$1[ ]$2")
        .replace(/\s+—\s+in progress\s*$/i, "");
    })
    .join("\n")
    .trim()
    .concat("\n");
}

function optionalSection(sections: Map<string, string[]>, name: string) {
  const value = sections.get(name)?.join("\n").trim();
  return value || undefined;
}

export function parseImplementationPlanMarkdown(value: unknown): ParsedImplementationPlanMarkdown {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("save requires the complete implementation-plan Markdown.");
  }
  if (value.length > MAX_MARKDOWN_LENGTH) {
    throw new Error(`The implementation plan must be at most ${MAX_MARKDOWN_LENGTH} characters.`);
  }

  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  const titleMatch = firstContentIndex >= 0 ? /^#\s+(.+?)\s*$/.exec(lines[firstContentIndex]!) : null;
  if (!titleMatch?.[1]) throw new Error("The implementation plan must start with one # title.");

  const sections = splitSections(lines.slice(firstContentIndex + 1));
  const approaches = numberedItems(sections.get("approaches") ?? []);
  if (approaches.length < 1 || approaches.length > 3) {
    throw new Error("The ## Approaches section requires one to three numbered approaches.");
  }
  const files = affectedFiles(sections.get("affected files") ?? []);
  if (files.length < 1 || files.length > 100) {
    throw new Error("The ## Affected files section requires one to one hundred bullet items.");
  }
  const implementationSteps = checklist(sections.get("steps") ?? [], "implementation");
  if (implementationSteps.length < 1 || implementationSteps.length > 8) {
    throw new Error("The ## Steps section requires one to eight checklist items.");
  }
  const verificationSteps = checklist(sections.get("verification") ?? [], "verification");
  if (verificationSteps.length < 1 || verificationSteps.length > 3) {
    throw new Error("The ## Verification section requires one to three checklist items.");
  }
  const rootCause = optionalSection(sections, "root cause");
  const intendedFix = optionalSection(sections, "intended fix");
  if (Boolean(rootCause) !== Boolean(intendedFix)) {
    throw new Error("Bug plans must include both ## Root cause and ## Intended fix sections.");
  }

  return {
    affectedFiles: files,
    approaches,
    goal: meaningful(sections.get("goal")?.join("\n"), "The ## Goal section"),
    intendedFix,
    markdown: normalizeMarkdown(lines.slice(firstContentIndex)),
    rootCause,
    steps: [...implementationSteps, ...verificationSteps],
    title: titleMatch[1].trim(),
  };
}
