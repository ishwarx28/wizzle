import { useMemo } from "react";

import { buildHunkDiff } from "../../lib/text-diff";

interface ToolDiffViewerProps {
  afterContent: string;
  beforeContent: string;
  diffTruncated?: boolean;
  title?: string;
}

function lineNumber(value?: number) {
  return value?.toString() ?? "";
}

export function ToolDiffViewer({
  afterContent,
  beforeContent,
  diffTruncated = false,
  title,
}: ToolDiffViewerProps) {
  const diff = useMemo(
    () => buildHunkDiff(beforeContent, afterContent),
    [afterContent, beforeContent],
  );

  return (
    <div className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--color-border)_80%,transparent)] bg-[color-mix(in_srgb,var(--color-panel-muted)_74%,transparent)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-tertiary)]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[var(--color-text-secondary)]">{title ?? "Diff"}</span>
          <span className="text-[#36d27c]">+{diff.addedCount}</span>
          <span className="text-[#ff5d5d]">-{diff.removedCount}</span>
        </div>
        {diffTruncated ? <span>Truncated</span> : null}
      </div>
      <div className="max-h-[160px] overflow-auto" data-code-block>
        {diff.hunks.length > 0 ? (
          <div className="min-w-full space-y-2 p-2 font-mono text-[11px] leading-5">
            {diff.hunks.map((hunk, hunkIndex) => (
              <div
                className="overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--color-border)_55%,transparent)]"
                key={`${hunk.header}-${hunkIndex}`}
              >
                <div className="border-b border-[color-mix(in_srgb,var(--color-border)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-panel-muted)_85%,transparent)] px-3 py-1.5 text-[10px] text-[var(--color-text-tertiary)]">
                  {hunk.header}
                </div>
                <div>
                  {hunk.lines.map((line, lineIndex) => (
                    <div
                      className={[
                        "grid grid-cols-[3rem_3rem_1rem_minmax(0,1fr)]",
                        line.kind === "added"
                          ? "bg-[rgba(24,69,44,0.95)] text-[#7dffb0]"
                          : "",
                        line.kind === "removed"
                          ? "bg-[rgba(82,28,28,0.95)] text-[#ff7d7d]"
                          : "",
                        line.kind === "context"
                          ? "bg-[color-mix(in_srgb,var(--color-panel-muted)_50%,transparent)]"
                          : "",
                      ].join(" ")}
                      key={`${hunkIndex}-${line.kind}-${line.oldLineNumber ?? "x"}-${line.newLineNumber ?? "x"}-${lineIndex}`}
                    >
                      <span
                        className={[
                          "border-r px-2 py-1 text-right",
                          line.kind === "added"
                            ? "border-[rgba(61,140,94,0.9)] text-[#49e38d]"
                            : line.kind === "removed"
                              ? "border-[rgba(151,63,63,0.9)] text-[#ff6666]"
                              : "border-[color-mix(in_srgb,var(--color-border)_40%,transparent)] text-[var(--color-text-tertiary)]",
                        ].join(" ")}
                      >
                        {lineNumber(line.oldLineNumber)}
                      </span>
                      <span
                        className={[
                          "border-r px-2 py-1 text-right",
                          line.kind === "added"
                            ? "border-[rgba(61,140,94,0.9)] text-[#49e38d]"
                            : line.kind === "removed"
                              ? "border-[rgba(151,63,63,0.9)] text-[#ff6666]"
                              : "border-[color-mix(in_srgb,var(--color-border)_40%,transparent)] text-[var(--color-text-tertiary)]",
                        ].join(" ")}
                      >
                        {lineNumber(line.newLineNumber)}
                      </span>
                      <span
                        className={[
                          "border-r px-1 py-1 text-center",
                          line.kind === "added"
                            ? "border-[rgba(61,140,94,0.9)] text-[#49e38d]"
                            : line.kind === "removed"
                              ? "border-[rgba(151,63,63,0.9)] text-[#ff6666]"
                              : "border-[color-mix(in_srgb,var(--color-border)_40%,transparent)] text-[var(--color-text-tertiary)]",
                        ].join(" ")}
                      >
                        {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : ""}
                      </span>
                      <pre
                        className={[
                          "whitespace-pre-wrap break-words px-3 py-1",
                          line.kind === "added"
                            ? "text-[#c9ffd9]"
                            : line.kind === "removed"
                              ? "text-[#ffd0d0]"
                              : "text-[var(--color-text-secondary)]",
                        ].join(" ")}
                      >
                        {line.text || " "}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">
            No textual changes available.
          </div>
        )}
      </div>
    </div>
  );
}
