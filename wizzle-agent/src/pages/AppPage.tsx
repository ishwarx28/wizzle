import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { useEffect, useState } from "react";

import { ChatView } from "../components/workspace/ChatView";
import { FilePanel } from "../components/workspace/FilePanel";
import { ProviderSettingsPage } from "../components/workspace/ProviderSettingsDialog";
import { SessionProcessMenu } from "../components/workspace/SessionProcessMenu";
import { Sidebar } from "../components/workspace/Sidebar";
import { usePanelResize } from "../hooks/use-panel-resize";
import { useWindowDrag } from "../hooks/use-window-drag";
import { frontendLogger } from "../lib/logger";
import { listProviderModels, listProviders, loadWorkspaceSnapshot } from "../lib/local-workspace";
import {
  interruptAllWorkspaceRunsForShutdown,
  useWorkspaceStore,
} from "../store/workspace-store";

function shouldAllowNativeContextMenu(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      [
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[contenteditable='']",
        "[role='textbox']",
        "[data-native-context-menu]",
      ].join(","),
    ),
  );
}

export function AppPage() {
  const [activePage, setActivePage] = useState<"chat" | "providers">("chat");
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupRetryKey, setStartupRetryKey] = useState(0);
  const hasHydratedWorkspace = useWorkspaceStore((state) => state.hasHydratedWorkspace);
  const draftSessions = useWorkspaceStore((state) => state.draftSessions);
  const isFilePanelOpen = useWorkspaceStore((state) => state.isFilePanelOpen);
  const isSidebarOpen = useWorkspaceStore((state) => state.isSidebarOpen);
  const projects = useWorkspaceStore((state) => state.projects);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const hydrateWorkspace = useWorkspaceStore((state) => state.hydrateWorkspace);
  const providerModelsError = useWorkspaceStore((state) => state.providerModelsError);
  const setProviderConfig = useWorkspaceStore((state) => state.setProviderConfig);
  const clearProviderModelsError = useWorkspaceStore((state) => state.clearProviderModelsError);
  const toggleFilePanel = useWorkspaceStore((state) => state.toggleFilePanel);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const windowDrag = useWindowDrag();
  const {
    filePanelWidth,
    panelContentTransitionClass,
    panelTransitionClass,
    shellRef,
    sidebarWidth,
    startFileResize,
    startSidebarResize,
  } = usePanelResize({
    isFilePanelOpen,
    isSidebarOpen,
  });

  const currentProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const currentDraftSession = currentProject ? draftSessions[currentProject.id] ?? null : null;
  const isDraftSession = currentDraftSession?.id === selectedSessionId;
  const currentSession = isDraftSession
    ? currentDraftSession
    : currentProject?.sessions.find((session) => session.id === selectedSessionId) ??
      projects.flatMap((project) => project.sessions).find((session) => session.id === selectedSessionId);

  useEffect(() => {
    if (hasHydratedWorkspace) {
      return;
    }

    let isMounted = true;

    void loadWorkspaceSnapshot()
      .then((snapshot) => {
        if (isMounted) {
          setStartupError(null);
          hydrateWorkspace(snapshot);
          frontendLogger.info("frontend.app", "workspace_hydrated", {
            projectCount: snapshot.projects.length,
            selectedProjectIdLength: snapshot.selectedProjectId.length,
            selectedSessionPresent: Boolean(snapshot.selectedSessionId),
          });
        }
      })
      .catch((error) => {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message
            : "Wizzle could not load the workspace.";
        frontendLogger.error("frontend.app", "workspace_hydration_failed", { error });
        if (isMounted) {
          setStartupError(message);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [hasHydratedWorkspace, hydrateWorkspace, startupRetryKey]);

  useEffect(() => {
    let isMounted = true;

    void Promise.all([listProviders(), listProviderModels()])
      .then(([providers, models]) => {
        if (isMounted) {
          setProviderConfig({ models, providers });
          frontendLogger.info("frontend.app", "provider_models_loaded", {
            modelCount: models.length,
            providerCount: providers.length,
          });
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        frontendLogger.error("frontend.app", "provider_models_load_failed", { error, message });
        if (isMounted) {
          useWorkspaceStore.setState({ providerModelsError: message });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [setProviderConfig]);

  useEffect(() => {
    // App close / refresh: pending approvals cannot be completed by a dead process.
    // Resolve them as interrupted and stop in-flight session runs (#26 restart policy).
    const handlePageHide = () => {
      void interruptAllWorkspaceRunsForShutdown();
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    let unlistenClose: (() => void) | undefined;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onCloseRequested(async () => {
        await interruptAllWorkspaceRunsForShutdown();
      }))
      .then((unlisten) => {
        unlistenClose = unlisten;
      })
      .catch(() => undefined);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
      unlistenClose?.();
    };
  }, []);

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
      if (shouldAllowNativeContextMenu(event.target)) {
        return;
      }

      event.preventDefault();
    }

    window.addEventListener("contextmenu", handleContextMenu);

    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  return (
    <>
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
              isSidebarOpen
                ? "translate-x-0 opacity-100"
                : "-translate-x-4 opacity-0 pointer-events-none",
            ].join(" ")}
            style={{ width: sidebarWidth }}
          >
            <Sidebar onOpenProviders={() => setActivePage("providers")} />
          </div>
          {isSidebarOpen ? (
            <div
              aria-label="Resize left panel"
              className="absolute right-0 top-0 z-20 h-full w-3 translate-x-1/2 cursor-col-resize touch-none select-none"
              onPointerDown={startSidebarResize}
            >
              <div className="mx-auto h-full w-px bg-transparent transition hover:bg-[var(--color-border-strong)]" />
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className={[
                "app-titlebar-region relative flex h-[calc(2.75rem+var(--titlebar-top-padding))] items-center justify-between border-b border-[var(--color-border)] px-5",
                !isSidebarOpen ? "app-titlebar-main-safe" : "",
              ].join(" ")}
              onPointerDownCapture={windowDrag.onPointerDownCapture}
            >
              <div className="relative z-10 flex min-w-0 items-center gap-3">
                {!isSidebarOpen ? (
                  <button
                    aria-label="Open sidebar"
                    className="rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                    onClick={toggleSidebar}
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </button>
                ) : null}
                <div className="min-w-0 select-none">
                  <p className="truncate text-[15px] font-medium leading-none text-[var(--color-text)]">
                    {activePage === "providers"
                      ? "Providers"
                      : currentSession?.title ??
                        (isDraftSession
                          ? "New session"
                          : currentProject
                            ? "Choose a session"
                            : "Choose a project")}
                  </p>
                </div>
              </div>

              <div className="relative z-10 flex shrink-0 items-center gap-0.5">
                {activePage === "chat" ? (
                  <SessionProcessMenu sessionId={currentSession?.id ?? selectedSessionId} />
                ) : null}
                {!isFilePanelOpen ? (
                  <button
                    aria-label="Open file panel"
                    className="rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                    onClick={toggleFilePanel}
                  >
                    <PanelRightOpen className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </header>

            {providerModelsError ? (
              <div
                className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-panel-muted)] px-5 py-3 text-[13px] text-[var(--color-text-secondary)]"
                role="status"
              >
                <span>
                  <span className="font-medium text-[var(--color-text)]">Provider settings need attention.</span>{" "}
                  {providerModelsError}
                </span>
                <button
                  className="ml-3 shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                  onClick={clearProviderModelsError}
                  type="button"
                  aria-label="Dismiss warning"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : null}

            {hasHydratedWorkspace && activePage === "providers" ? (
              <ProviderSettingsPage onBack={() => setActivePage("chat")} />
            ) : hasHydratedWorkspace ? (
              <ChatView />
            ) : startupError ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10">
                <div className="max-w-[360px] rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 text-center shadow-[0_18px_40px_rgba(0,0,0,0.18)]">
                  <p className="text-[15px] font-medium text-[var(--color-text)]">
                    Wizzle could not start
                  </p>
                  <p className="mt-2 text-[13px] leading-5 text-[var(--color-text-secondary)]">
                    {startupError}
                  </p>
                  <button
                    className="mt-4 h-10 rounded-full bg-[var(--color-accent)] px-4 text-[14px] font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)]"
                    onClick={() => {
                      setStartupError(null);
                      setStartupRetryKey((value) => value + 1);
                    }}
                  >
                    Retry
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-[14px] text-[var(--color-text-secondary)]">
                Loading workspace...
              </div>
            )}
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
                className="absolute left-0 top-0 z-20 h-full w-3 -translate-x-1/2 cursor-col-resize touch-none select-none"
                onPointerDown={startFileResize}
              >
                <div className="mx-auto h-full w-px bg-transparent transition hover:bg-[var(--color-border-strong)]" />
              </div>
            ) : null}
            <div
              aria-hidden={!isFilePanelOpen}
              className={[
                "h-full",
                panelContentTransitionClass,
                isFilePanelOpen
                  ? "translate-x-0 opacity-100"
                  : "translate-x-4 opacity-0 pointer-events-none",
              ].join(" ")}
              style={{ width: filePanelWidth }}
            >
              <FilePanel />
            </div>
          </div>
        </div>
      </div>

    </>
  );
}
