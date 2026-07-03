import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "../auth/auth-context";
import { ChatView } from "../components/workspace/ChatView";
import { FilePanel } from "../components/workspace/FilePanel";
import { Sidebar } from "../components/workspace/Sidebar";
import { useWorkspaceStore } from "../store/workspace-store";

const DEFAULT_SIDEBAR_WIDTH = 310;
const DEFAULT_FILE_PANEL_WIDTH = 420;
const MIN_SIDEBAR_WIDTH = 250;
const MAX_SIDEBAR_WIDTH = 460;
const MIN_FILE_PANEL_WIDTH = 320;
const MAX_FILE_PANEL_WIDTH = 640;
const MIN_CENTER_WIDTH = 560;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function AppPage() {
  const { user } = useAuth();
  const isFilePanelOpen = useWorkspaceStore((state) => state.isFilePanelOpen);
  const isSidebarOpen = useWorkspaceStore((state) => state.isSidebarOpen);
  const projects = useWorkspaceStore((state) => state.projects);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const draftSessionProjectId = useWorkspaceStore((state) => state.draftSessionProjectId);
  const toggleFilePanel = useWorkspaceStore((state) => state.toggleFilePanel);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [filePanelWidth, setFilePanelWidth] = useState(DEFAULT_FILE_PANEL_WIDTH);
  const [activeResize, setActiveResize] = useState<"sidebar" | "file" | null>(null);

  const currentProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const isDraftSession = currentProject?.id === draftSessionProjectId && selectedSessionId === null;
  const currentSession = isDraftSession
    ? null
    : currentProject?.sessions.find((session) => session.id === selectedSessionId) ??
      projects.flatMap((project) => project.sessions).find((session) => session.id === selectedSessionId) ??
      currentProject?.sessions[0];
  const panelTransitionClass =
    activeResize === null ? "transition-[width] duration-300 ease-out" : "transition-none";
  const panelContentTransitionClass =
    activeResize === null ? "transition-all duration-300 ease-out" : "transition-none";

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isToggleShortcut = event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey);

      if (!isToggleShortcut) {
        return;
      }

      event.preventDefault();
      toggleSidebar();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggleSidebar]);

  useEffect(() => {
    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
    }

    window.addEventListener("contextmenu", handleContextMenu);

    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  useEffect(() => {
    if (activeResize === null) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const shell = shellRef.current;

      if (!shell) {
        return;
      }

      const bounds = shell.getBoundingClientRect();
      const shellWidth = bounds.width;

      if (activeResize === "sidebar") {
        const remainingFileWidth = isFilePanelOpen ? filePanelWidth : 0;
        const maxWidth = Math.min(
          MAX_SIDEBAR_WIDTH,
          shellWidth - remainingFileWidth - MIN_CENTER_WIDTH,
        );

        setSidebarWidth(
          clamp(event.clientX - bounds.left, MIN_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, maxWidth)),
        );
        return;
      }

      const remainingSidebarWidth = isSidebarOpen ? sidebarWidth : 0;
      const maxWidth = Math.min(
        MAX_FILE_PANEL_WIDTH,
        shellWidth - remainingSidebarWidth - MIN_CENTER_WIDTH,
      );

      setFilePanelWidth(
        clamp(bounds.right - event.clientX, MIN_FILE_PANEL_WIDTH, Math.max(MIN_FILE_PANEL_WIDTH, maxWidth)),
      );
    }

    function handlePointerUp() {
      setActiveResize(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [activeResize, filePanelWidth, isFilePanelOpen, isSidebarOpen, sidebarWidth]);

  return (
    <div
      className="flex h-screen overflow-hidden bg-[var(--color-app-bg)] text-[var(--color-text)]"
      ref={shellRef}
    >
      <div
        className={[
          "relative overflow-hidden",
          panelTransitionClass,
          isSidebarOpen ? "" : "w-0",
        ].join(" ")}
        style={{ width: isSidebarOpen ? sidebarWidth : 0 }}
      >
        <div
          aria-hidden={!isSidebarOpen}
          className={[
            "h-full",
            panelContentTransitionClass,
            isSidebarOpen ? "translate-x-0 opacity-100" : "-translate-x-4 opacity-0 pointer-events-none",
          ].join(" ")}
          style={{ width: sidebarWidth }}
        >
          <Sidebar />
        </div>
        {isSidebarOpen ? (
          <div
            aria-label="Resize left panel"
            className="absolute right-0 top-0 z-20 h-full w-3 translate-x-1/2 cursor-col-resize"
            onPointerDown={() => setActiveResize("sidebar")}
          >
            <div className="mx-auto h-full w-px bg-transparent transition hover:bg-[var(--color-border-strong)]" />
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className={[
              "app-titlebar-region flex h-[calc(2.75rem+var(--titlebar-top-padding))] items-center justify-between border-b border-[var(--color-border)] px-5",
              !isSidebarOpen ? "app-titlebar-main-safe" : "",
            ].join(" ")}
            data-tauri-drag-region
          >
            <div className="flex min-w-0 items-center gap-3">
              {!isSidebarOpen ? (
                <button
                  aria-label="Open sidebar"
                  className="rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  onClick={toggleSidebar}
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              ) : null}
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium leading-none text-[var(--color-text)]">
                  {currentSession?.title ?? (isDraftSession ? "New session" : "Workspace")}
                </p>
              </div>
            </div>

            {!isFilePanelOpen ? (
              <button
                aria-label="Open file panel"
                className="rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={toggleFilePanel}
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            ) : null}
          </header>

          {!user?.emailVerified ? (
            <div className="border-b border-[var(--color-border)] bg-[var(--color-panel-muted)] px-5 py-3 text-[13px] text-[var(--color-text-secondary)]">
              Check your inbox and spam folder to verify your email. You can keep using Wizzle while verification is pending.
            </div>
          ) : null}

          <ChatView />
        </div>

        <div
          className={[
            "relative overflow-hidden",
            panelTransitionClass,
            isFilePanelOpen ? "" : "w-0",
          ].join(" ")}
          style={{ width: isFilePanelOpen ? filePanelWidth : 0 }}
        >
          {isFilePanelOpen ? (
            <div
              aria-label="Resize right panel"
              className="absolute left-0 top-0 z-20 h-full w-3 -translate-x-1/2 cursor-col-resize"
              onPointerDown={() => setActiveResize("file")}
            >
              <div className="mx-auto h-full w-px bg-transparent transition hover:bg-[var(--color-border-strong)]" />
            </div>
          ) : null}
          <div
            aria-hidden={!isFilePanelOpen}
            className={[
              "h-full",
              panelContentTransitionClass,
              isFilePanelOpen ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0 pointer-events-none",
            ].join(" ")}
            style={{ width: filePanelWidth }}
          >
            <FilePanel />
          </div>
        </div>
      </div>
    </div>
  );
}
