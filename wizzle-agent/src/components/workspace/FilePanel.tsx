import { useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ExternalLink,
  FileCode2,
  FileImage,
  FileText,
  FolderSearch,
  PanelRightClose,
  X,
} from "lucide-react";

import { MarkdownRenderer } from "../common/MarkdownRenderer";
import { useWindowDrag } from "../../hooks/use-window-drag";
import { useScrollActivity } from "../../hooks/use-scroll-activity";
import { isAbsoluteNativePath, resolveFileOpenLabel } from "../../lib/file-preview";
import { frontendLogger } from "../../lib/logger";
import { useWorkspaceStore } from "../../store/workspace-store";
import { CodePreview } from "./CodePreview";

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
  const [fileActionMessage, setFileActionMessage] = useState<string | null>(null);
  const windowDrag = useWindowDrag();
  const tabsScroll = useScrollActivity();
  const contentScroll = useScrollActivity();

  const openedFiles = openedFileIds
    .map((fileId) => previewFiles.find((file) => file.id === fileId))
    .filter((file): file is NonNullable<typeof file> => Boolean(file));
  const activeFile = previewFiles.find((file) => file.id === activeFileId) ?? openedFiles[0] ?? null;

  useEffect(() => {
    setFileActionMessage(null);
  }, [activeFileId]);

  const activeRealPath = isAbsoluteNativePath(activeFile?.realPath) ? activeFile?.realPath : null;
  const activeFileOpenLabel = activeFile ? resolveFileOpenLabel(activeFile) : "Open file";

  async function handleOpenActiveFile() {
    if (!activeRealPath) {
      return;
    }

    setFileActionMessage(null);
    try {
      await openPath(activeRealPath);
    } catch (error) {
      frontendLogger.error("frontend.file_panel", "open_file_failed", { error });
      setFileActionMessage("Wizzle could not open this file with its default app.");
    }
  }

  async function handleRevealActiveFile() {
    if (!activeRealPath) {
      return;
    }

    setFileActionMessage(null);
    try {
      await revealItemInDir(activeRealPath);
    } catch (error) {
      frontendLogger.error("frontend.file_panel", "reveal_file_failed", { error });
      setFileActionMessage("Wizzle could not reveal this file.");
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
                    "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[13px] transition",
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
            <div className="flex items-center text-[13px] text-[var(--color-text-tertiary)]">
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
                <h2 className="break-words text-ui-tight font-medium text-[var(--color-text)]">
                  {activeFile.name}
                </h2>
                <p className="mt-1 break-all text-meta-tight text-[var(--color-text-tertiary)]">
                  {activeFile.path}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                {activeRealPath ? (
                  <>
                    <button
                      aria-label={activeFileOpenLabel}
                      className="rounded-full p-1.5 text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                      onClick={() => void handleOpenActiveFile()}
                      title={activeFileOpenLabel}
                      type="button"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                    <button
                      aria-label="Reveal in file manager"
                      className="rounded-full p-1.5 text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                      onClick={() => void handleRevealActiveFile()}
                      title="Reveal in file manager"
                      type="button"
                    >
                      <FolderSearch className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            {fileActionMessage ? (
              <p className="mb-3 text-[12px] text-[var(--color-danger)]" role="alert">
                {fileActionMessage}
              </p>
            ) : null}

            {activeFile.kind === "markdown" ? (
              <MarkdownRenderer content={activeFile.content ?? ""} />
            ) : null}

            {activeFile.kind === "text" ? (
              <CodePreview content={activeFile.content ?? ""} language={activeFile.language} />
            ) : null}

            {activeFile.kind === "image" ? (
              <div className="space-y-4">
                <img
                  alt={activeFile.name}
                  className="max-h-[340px] w-full object-contain"
                  src={activeFile.imageSrc}
                />
                <p className="text-ui text-[var(--color-text-secondary)]">
                  {activeFile.summary}
                </p>
              </div>
            ) : null}

            {activeFile.kind === "other" ? (
              <div className="border border-dashed border-[var(--color-border)] px-4 py-4 text-ui text-[var(--color-text-secondary)]">
                {activeFile.summary || "Preview is not available for this file type yet."}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center border border-dashed border-[var(--color-border)] px-6 py-8 text-center text-ui text-[var(--color-text-secondary)]">
            Open a file from chat to preview it here.
          </div>
        )}
      </div>
    </aside>
  );
}
