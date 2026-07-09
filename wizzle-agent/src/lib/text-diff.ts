import { structuredPatch } from "diff";

export type DiffLine = {
  kind: "added" | "context" | "removed";
  newLineNumber?: number;
  oldLineNumber?: number;
  text: string;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
};

export type HunkDiff = {
  addedCount: number;
  hunks: DiffHunk[];
  removedCount: number;
};

function toDiffLine(
  line: string,
  counters: { newLineNumber: number; oldLineNumber: number },
): DiffLine | null {
  if (line.startsWith("\\")) {
    return null;
  }

  if (line.startsWith("-")) {
    const nextLine: DiffLine = {
      kind: "removed",
      oldLineNumber: counters.oldLineNumber,
      text: line.slice(1),
    };
    counters.oldLineNumber += 1;
    return nextLine;
  }

  if (line.startsWith("+")) {
    const nextLine: DiffLine = {
      kind: "added",
      newLineNumber: counters.newLineNumber,
      text: line.slice(1),
    };
    counters.newLineNumber += 1;
    return nextLine;
  }

  const nextLine: DiffLine = {
    kind: "context",
    newLineNumber: counters.newLineNumber,
    oldLineNumber: counters.oldLineNumber,
    text: line.startsWith(" ") ? line.slice(1) : line,
  };
  counters.oldLineNumber += 1;
  counters.newLineNumber += 1;
  return nextLine;
}

export function buildHunkDiff(before: string, after: string): HunkDiff {
  if (before === after) {
    return {
      addedCount: 0,
      hunks: [],
      removedCount: 0,
    };
  }

  const patch = structuredPatch("before", "after", before, after, "", "", {
    context: 3,
  });

  let addedCount = 0;
  let removedCount = 0;
  const hunks = patch.hunks.map((hunk) => {
    const counters = {
      newLineNumber: hunk.newStart,
      oldLineNumber: hunk.oldStart,
    };
    const lines = hunk.lines
      .map((line) => {
        const nextLine = toDiffLine(line, counters);

        if (nextLine?.kind === "added") {
          addedCount += 1;
        }

        if (nextLine?.kind === "removed") {
          removedCount += 1;
        }

        return nextLine;
      })
      .filter((line): line is DiffLine => Boolean(line));

    return {
      header: hunk.lines.length > 0 && hunk.lines[0]?.startsWith("@@")
        ? hunk.lines[0]
        : `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      lines,
      newLines: hunk.newLines,
      newStart: hunk.newStart,
      oldLines: hunk.oldLines,
      oldStart: hunk.oldStart,
    } satisfies DiffHunk;
  });

  return {
    addedCount,
    hunks,
    removedCount,
  };
}
