import { useEffect, useState } from "react";
import { Copy, FileCode2, FileImage, FileText, PanelRightClose, X } from "lucide-react";

import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { useWindowDrag } from "../../hooks/use-window-drag";
import { useScrollActivity } from "../../hooks/use-scroll-activity";
import { useWorkspaceStore } from "../../store/workspace-store";
import { copyImage, copyText } from "../../utils/clipboard";

function fileIcon(kind: "markdown" | "text" | "image" | "other") {
  switch (kind) {
    case "markdown":
      return <FileText className="h-4 w-4" />;
    case "text":
      return <FileCode2 className="h-4 w-4" />;
    case "image":
      return <FileImage className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
}

export function FilePanel() {
  const previewFiles = useWorkspaceStore((state) => state.previewFiles);
  const activeFileId = useWorkspaceStore((state) => state.activeFileId);
  const openedFileIds = useWorkspaceStore((state) => state.openedFileIds);
  const closeFile = useWorkspaceStore((state) => state.closeFile);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const toggleFilePanel = useWorkspaceStore((state) => state.toggleFilePanel);
  const [isCopied, setIsCopied] = useState(false);
  const windowDrag = useWindowDrag();
  const tabsScroll = useScrollActivity();
  const contentScroll = useScrollActivity();

  const openedFiles = openedFileIds
    .map((fileId) => previewFiles.find((file) => file.id === fileId))
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  const activeFile = previewFiles.find((file) => file.id === activeFileId) ?? openedFiles[0] ?? null;

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

  useEffect(() => {
    setIsCopied(false);
  }, [activeFileId]);

  const canCopyActiveFile =
    activeFile?.kind === "markdown" ||
    activeFile?.kind === "text" ||
    (activeFile?.kind === "image" && Boolean(activeFile.imageSrc));

  async function handleCopyActiveFile() {
    if (!activeFile) {
      return;
    }

    const didCopy =
      activeFile.kind === "image" && activeFile.imageSrc
        ? await copyImage(activeFile.imageSrc)
        : await copyText(activeFile.content ?? "");

    if (didCopy) {
      setIsCopied(true);
    }
  }

  return (
    <aside
      className="flex h-full w-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel-sidebar)]"
      data-file-panel
    >
      <div
        className="app-titlebar-region relative flex h-[calc(2.75rem+var(--titlebar-top-padding))] items-center gap-2 border-b border-[var(--color-border)] px-3"
        onPointerDownCapture={windowDrag.onPointerDownCapture}
      >
        <div
          className={[
            "no-scrollbar relative z-10 flex min-w-0 flex-1 gap-1 overflow-x-auto whitespace-nowrap",
          ].join(" ")}
          onScroll={tabsScroll.handleScrollActivity}
        >
          {openedFiles.length > 0 ? (
            openedFiles.map((file) => {
              const isActive = file.id === activeFile?.id;

              return (
                <div
                  className={[
                    "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition",
                    isActive
                      ? "border-[var(--color-border-strong)] bg-[var(--color-panel-active)] text-[var(--color-text)]"
                      : "border-[var(--color-border)] bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-panel-hover)]",
                  ].join(" ")}
                  key={file.id}
                >
                  <button
                    className="flex shrink-0 items-center gap-1.5"
                    onClick={() => openFile(file.id)}
                  >
                    {fileIcon(file.kind)}
                    <span className="max-w-[180px] truncate">{file.name}</span>
                  </button>
                  <button
                    aria-label={`Close ${file.name}`}
                    className="rounded-sm p-0.5 transition hover:bg-[var(--color-panel-hover)]"
                    onClick={() => closeFile(file.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })
          ) : (
            <div className="flex items-center text-[12px] text-[var(--color-text-tertiary)]">
              No opened files
            </div>
          )}
        </div>
        <button
          aria-label="Collapse file panel"
          className="relative z-10 rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          onClick={toggleFilePanel}
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div
        className={[
          "auto-hide-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4",
          contentScroll.isScrolling ? "is-scrolling" : "",
        ].join(" ")}
        onScroll={contentScroll.handleScrollActivity}
      >
        {activeFile ? (
          <div>
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-[15px] font-medium text-[var(--color-text)]">
                  {activeFile.name}
                </h2>
                <p className="mt-1 break-all text-[12px] text-[var(--color-text-tertiary)]">
                  {activeFile.path}
                </p>
              </div>
              {canCopyActiveFile ? (
                <button
                  className={[
                    "inline-flex shrink-0 items-center gap-1 rounded-full px-1 py-0.5 transition",
                    isCopied
                      ? "cursor-default text-[var(--color-text-secondary)]"
                      : "text-[var(--color-text-tertiary)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
                  ].join(" ")}
                  disabled={isCopied}
                  onClick={() => {
                    void handleCopyActiveFile();
                  }}
                >
                  <Copy className="h-3 w-3" />
                  <span className="text-[11px] font-normal uppercase leading-none tracking-[0.08em]">
                    {isCopied ? "Copied" : "Copy"}
                  </span>
                </button>
              ) : null}
            </div>

            {activeFile.kind === "markdown" ? (
              <MarkdownRenderer content={activeFile.content ?? ""} />
            ) : null}

            {activeFile.kind === "text" ? (
              <pre
                className="overflow-x-auto whitespace-pre-wrap break-words bg-transparent p-0 font-mono text-[12px] leading-6 text-[var(--color-text)]"
                data-terminal-output
              >
                {activeFile.content ?? ""}
              </pre>
            ) : null}

            {activeFile.kind === "image" ? (
              <div className="space-y-4">
                <img
                  alt={activeFile.name}
                  className="max-h-[340px] w-full object-contain"
                  src={activeFile.imageSrc}
                />
                <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                  {activeFile.summary}
                </p>
              </div>
            ) : null}

            {activeFile.kind === "other" ? (
              <div className="border border-dashed border-[var(--color-border)] px-4 py-4 text-sm text-[var(--color-text-secondary)]">
                {activeFile.summary || "Preview is not available for this file type yet."}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center border border-dashed border-[var(--color-border)] px-6 py-8 text-center text-sm leading-6 text-[var(--color-text-secondary)]">
            Open a file from chat to preview it here.
          </div>
        )}
      </div>
    </aside>
  );
}
