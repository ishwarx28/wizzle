import { buildPreviewMarkdown, shouldHighlightPreview } from "../../lib/file-preview";
import { MarkdownRenderer } from "../common/MarkdownRenderer";

export function CodePreview({ content, language }: { content: string; language?: string }) {
  if (shouldHighlightPreview(content)) {
    return <MarkdownRenderer className="file-code-preview" content={buildPreviewMarkdown(content, language)} />;
  }

  return (
    <div>
      <p className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">
        Highlighting skipped for this large preview.
      </p>
      <pre
        className="overflow-x-auto whitespace-pre-wrap break-words bg-transparent p-0 font-mono text-ui text-[var(--color-text)]"
        data-terminal-output
      >
        {content}
      </pre>
    </div>
  );
}
