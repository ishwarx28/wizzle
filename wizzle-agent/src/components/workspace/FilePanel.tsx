import { FileCode2, FileImage, FileText, PanelRightClose, X } from "lucide-react";
import ReactMarkdown from "react-markdown";

import { useScrollActivity } from "../../hooks/use-scroll-activity";
import { useWorkspaceStore } from "../../store/workspace-store";

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
  const tabsScroll = useScrollActivity();
  const contentScroll = useScrollActivity();

  const openedFiles = openedFileIds
    .map((fileId) => previewFiles.find((file) => file.id === fileId))
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  const activeFile = previewFiles.find((file) => file.id === activeFileId) ?? openedFiles[0] ?? null;

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-panel-sidebar)]">
      <div
        className="app-titlebar-region flex h-[calc(2.75rem+var(--titlebar-top-padding))] items-center gap-2 border-b border-[var(--color-border)] px-3"
        data-tauri-drag-region
      >
        <div
          className={[
            "auto-hide-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto",
            tabsScroll.isScrolling ? "is-scrolling" : "",
          ].join(" ")}
          onScroll={tabsScroll.handleScrollActivity}
        >
          {openedFiles.length > 0 ? (
            openedFiles.map((file) => {
              const isActive = file.id === activeFile?.id;

              return (
                <div
                  className={[
                    "flex min-w-0 items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition",
                    isActive
                      ? "border-[var(--color-border-strong)] bg-[var(--color-panel-active)] text-[var(--color-text)]"
                      : "border-[var(--color-border)] bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-panel-hover)]",
                  ].join(" ")}
                  key={file.id}
                >
                  <button
                    className="flex min-w-0 items-center gap-1.5"
                    onClick={() => openFile(file.id)}
                  >
                    {fileIcon(file.kind)}
                    <span className="truncate">{file.name}</span>
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
          className="rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
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
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[15px] font-medium text-[var(--color-text)]">{activeFile.name}</h2>
                <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">{activeFile.path}</p>
              </div>
              <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                {activeFile.kind}
              </div>
            </div>

            {activeFile.kind === "markdown" ? (
              <div className="markdown-body">
                <ReactMarkdown>{activeFile.content ?? ""}</ReactMarkdown>
              </div>
            ) : null}

            {activeFile.kind === "text" ? (
              <pre className="overflow-x-auto text-sm leading-7 text-[var(--color-code-text)]">
                <code>{activeFile.content}</code>
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
                Preview is not available for this file type yet.
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
