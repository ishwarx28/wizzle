import { useEffect, useState } from "react";
import { Copy, FileCode2, FileImage, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";

import type { Message, PreviewFile } from "../../types/workspace";
import { copyText } from "../../utils/clipboard";

interface MessageBubbleProps {
  fileMap: Map<string, PreviewFile>;
  isLatest: boolean;
  message: Message;
  onOpenFile: (fileId: string) => void;
}

function fileIcon(kind: PreviewFile["kind"]) {
  switch (kind) {
    case "markdown":
    case "text":
      return <FileText className="h-4 w-4" />;
    case "image":
      return <FileImage className="h-4 w-4" />;
    default:
      return <FileCode2 className="h-4 w-4" />;
  }
}

export function MessageBubble({ fileMap, isLatest, message, onOpenFile }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [isCopied, setIsCopied] = useState(false);
  const linkedFiles = (message.linkedFileIds ?? [])
    .map((fileId) => fileMap.get(fileId))
    .filter((file): file is PreviewFile => Boolean(file));

  useEffect(() => {
    if (!isCopied) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsCopied(false);
    }, 1600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isCopied]);

  return (
    <div className={isUser ? "group flex justify-end" : "group flex w-full"}>
      <div className={isUser ? "max-w-[78%]" : "w-full"}>
        <div
          className={
            isUser
              ? "rounded-[26px] rounded-br-md bg-[var(--color-user-bubble)] px-5 py-4 text-[15px] leading-7 text-[var(--color-text)]"
              : "px-1 py-1 text-[15px] leading-7 text-[var(--color-text)]"
          }
        >
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="markdown-body">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>

        {linkedFiles.length > 0 ? (
          <div className="mt-4 space-y-2">
            {linkedFiles.map((file) => (
              <button
                className="flex w-full items-center justify-between gap-3 rounded-[24px] border border-[var(--color-border)] bg-[var(--color-panel-card)] px-4 py-4 text-left transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-panel-hover)]"
                key={file.id}
                onClick={() => onOpenFile(file.id)}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-panel-muted)] text-[var(--color-text)]">
                    {fileIcon(file.kind)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-medium text-[var(--color-text)]">
                      {file.name}
                    </p>
                    <p className="truncate text-sm text-[var(--color-text-tertiary)]">
                      {file.summary}
                    </p>
                  </div>
                </div>
                <span className="text-sm text-[var(--color-text-secondary)]">Open</span>
              </button>
            ))}
          </div>
        ) : null}

        <div
          className={[
            "mt-1.5 flex items-center gap-3 px-1 text-xs text-[var(--color-text-tertiary)] transition-opacity",
            isUser ? "justify-end" : "justify-start",
            isLatest ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          ].join(" ")}
        >
          <button
            className={[
              "inline-flex items-center gap-1 rounded-full px-2 py-1 transition",
              isCopied
                ? "cursor-default text-[var(--color-text-secondary)]"
                : "hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
            ].join(" ")}
            disabled={isCopied}
            onClick={async () => {
              const didCopy = await copyText(message.content);

              if (didCopy) {
                setIsCopied(true);
              }
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {isCopied ? "Copied" : "Copy"}
          </button>
          <span>{message.createdAtLabel}</span>
        </div>
      </div>
    </div>
  );
}
