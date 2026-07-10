import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleX,
  Copy,
  Folder,
  FolderOpenDot,
  FolderPlus,
  Laptop,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Power,
  Settings,
  Sun,
  SquarePen,
  Trash2,
} from "lucide-react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useWindowDrag } from "../../hooks/use-window-drag";
import { useScrollActivity } from "../../hooks/use-scroll-activity";
import {
  addProjectFromPath,
  removeProjectById,
  selectProjectFolder,
} from "../../lib/local-workspace";
import { useWorkspaceStore } from "../../store/workspace-store";
import { copyText } from "../../utils/clipboard";
import type { ThemePreference } from "../../utils/theme";
import {
  applyThemePreference,
  getStoredThemePreference,
  getThemeChangeEventName,
} from "../../utils/theme";
import { AppDialog } from "../common/AppDialog";
import { LogoMark } from "../common/LogoMark";

type DialogState =
  | { type: "confirm-exit" }
  | { projectId: string; projectName: string; type: "remove-project" }
  | { projectId: string; sessionId: string; sessionTitle: string; type: "delete-session" }
  | { projectId: string; sessionId: string; value: string; type: "rename-session" };

type MenuState = {
  align: "end" | "start";
  key: string;
  width?: number;
  vertical: "above" | "below";
  x: number;
  y: number;
};

export function Sidebar({ onOpenProviders }: { onOpenProviders?: () => void }) {
  const draftSessions = useWorkspaceStore((state) => state.draftSessions);
  const projects = useWorkspaceStore((state) => state.projects);
  const pendingToolApprovalsBySessionId = useWorkspaceStore(
    (state) => state.pendingToolApprovalsBySessionId,
  );
  const sendingSessionIds = useWorkspaceStore((state) => state.sendingSessionIds);
  const sessionStreamErrors = useWorkspaceStore((state) => state.sessionStreamErrors);
  const hydrateWorkspace = useWorkspaceStore((state) => state.hydrateWorkspace);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const deleteDraftSession = useWorkspaceStore((state) => state.deleteDraftSession);
  const deleteSession = useWorkspaceStore((state) => state.deleteSession);
  const renameDraftSession = useWorkspaceStore((state) => state.renameDraftSession);
  const renameSession = useWorkspaceStore((state) => state.renameSession);
  const selectSession = useWorkspaceStore((state) => state.selectSession);
  const toggleProjectExpanded = useWorkspaceStore((state) => state.toggleProjectExpanded);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  const [isThemeExpanded, setIsThemeExpanded] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getStoredThemePreference());
  const { handleScrollActivity, isScrolling } = useScrollActivity();
  const windowDrag = useWindowDrag();

  const menuKey = menu?.key ?? null;

  function isDraftSessionId(sessionId: string) {
    return sessionId.startsWith("draft-");
  }

  useEffect(() => {
    if (!menu) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;

      if (target?.closest("[data-sidebar-menu]") || target?.closest("[data-sidebar-menu-trigger]")) {
        return;
      }

      setMenu(null);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenu(null);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [menu]);

  useEffect(() => {
    function syncThemePreference() {
      setThemePreference(getStoredThemePreference());
    }

    window.addEventListener(getThemeChangeEventName(), syncThemePreference);

    return () => {
      window.removeEventListener(getThemeChangeEventName(), syncThemePreference);
    };
  }, []);

  function closeDialog() {
    setDialog(null);
  }

  async function handleAddProject() {
    if (isAddingProject) {
      return;
    }

    setIsAddingProject(true);

    try {
      const selectedPath = await selectProjectFolder();

      if (!selectedPath) {
        return;
      }

      const snapshot = await addProjectFromPath(selectedPath);
      hydrateWorkspace(snapshot);
    } finally {
      setIsAddingProject(false);
    }
  }

  function openAnchoredMenu(key: string, element: HTMLElement) {
    const rect = element.getBoundingClientRect();

    setMenu({
      key,
      x: rect.right,
      y: rect.bottom + 6,
      align: "end",
      vertical: "below",
    });
  }

  function openContextMenu(key: string, x: number, y: number) {
    setMenu({
      key,
      x: Math.min(x + 6, window.innerWidth - 16),
      y: Math.min(y + 6, window.innerHeight - 16),
      align: "start",
      vertical: "below",
    });
  }

  function renderFloatingMenu(
    key: string,
    items: Array<{
      danger?: boolean;
      icon: ReactNode;
      label: string;
      onSelect: () => void | Promise<void>;
    }>,
  ) {
    if (menuKey !== key || !menu) {
      return null;
    }

    return createPortal(
      <div
        className="fixed z-[300] min-w-[168px] rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1 shadow-[0_14px_36px_rgba(0,0,0,0.3)]"
        data-sidebar-menu
        style={{
          left: menu.x,
          top: menu.y,
          transform: [
            menu.align === "end" ? "translateX(-100%)" : "",
            menu.vertical === "above" ? "translateY(-100%)" : "",
          ]
            .filter(Boolean)
            .join(" "),
        }}
      >
        {items.map((item) => (
          <button
            className={[
              "flex w-full items-center gap-2 rounded-xl px-3 py-2 transition hover:bg-[var(--color-panel-hover)] [&_svg]:h-3.5 [&_svg]:w-3.5",
              item.danger ? "text-[var(--color-danger)]" : "text-[var(--color-text)]",
            ].join(" ")}
            key={item.label}
            onClick={async () => {
              await item.onSelect();
              setMenu(null);
            }}
          >
            {item.icon}
            <span className="whitespace-nowrap text-[13px] leading-none font-normal tracking-normal">
              {item.label}
            </span>
          </button>
        ))}
      </div>,
      document.body,
    );
  }

  return (
    <>
      <aside className="flex h-full w-full flex-col border-r border-[var(--color-border)] bg-[var(--color-panel-sidebar)]">
        <div
          className="app-titlebar-region app-titlebar-sidebar relative flex items-center justify-between pb-2 pr-4 pt-4"
          onPointerDownCapture={windowDrag.onPointerDownCapture}
        >
          <div className="relative z-10 flex items-center gap-3 select-none">
            <LogoMark className="h-7 w-7 object-contain" />
            <div>
              <p className="text-sm font-semibold text-[var(--color-text)]">Wizzle</p>
            </div>
          </div>
          <button
            aria-label="Collapse sidebar"
            className="relative z-10 rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            onClick={toggleSidebar}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        {projects.length > 0 ? (
          <div className="px-3">
            <button
              className="flex h-8 w-full items-center gap-3 rounded-lg px-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
              disabled={isAddingProject}
              onClick={() => {
                void handleAddProject();
              }}
            >
              <FolderPlus className="h-4 w-4" />
              <span className="text-[15px] font-normal leading-[1.1]">
                {isAddingProject ? "Selecting project..." : "Add new project"}
              </span>
            </button>
          </div>
        ) : null}

        <div
          className={[
            "auto-hide-scrollbar mt-2 flex-1 overflow-y-auto px-2 pb-4",
            isScrolling ? "is-scrolling" : "",
          ].join(" ")}
          onScroll={handleScrollActivity}
        >
          {projects.length === 0 ? (
            <div className="flex h-full min-h-full items-center justify-center px-6 pb-10">
              <div className="max-w-[220px] text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[20px] bg-[var(--color-panel-muted)] ring-1 ring-[var(--color-border)]">
                  <FolderOpenDot className="h-6 w-6 text-[var(--color-text-secondary)]" />
                </div>
                <p className="text-[15px] font-medium text-[var(--color-text)]">No projects yet</p>
                <p className="mt-2 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                  Add a local folder to start a workspace.
                </p>
                <button
                  className="mt-5 inline-flex h-9 items-center justify-center rounded-xl bg-[var(--color-text)] px-4 text-[var(--color-app-bg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isAddingProject}
                  onClick={() => {
                    void handleAddProject();
                  }}
                >
                  <span className="text-[11px] font-medium leading-none">
                    {isAddingProject ? "Selecting..." : "Add Project"}
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-1.5 mt-1 px-2 text-[13px] font-medium text-[var(--color-text-tertiary)]">
                Projects
              </div>
              <div className="space-y-1">
                {projects.map((project) => {
              const projectMenuKey = project.id;
              const draftSession = draftSessions[project.id] ?? null;
              const isDraftActive =
                project.id === selectedProjectId && draftSession?.id === selectedSessionId;

              return (
                <div className="px-1 py-0.5" key={project.id}>
                  <div
                    className={[
                      "group/project relative flex min-w-0 items-center gap-1 rounded-2xl px-1 py-0.5 transition",
                      menuKey === projectMenuKey ? "z-20 bg-[var(--color-panel-hover)]" : "hover:bg-[var(--color-panel-hover)]",
                    ].join(" ")}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      openContextMenu(projectMenuKey, event.clientX, event.clientY);
                    }}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-2 py-1.5 text-left text-[var(--color-text-secondary)]"
                      onClick={() => toggleProjectExpanded(project.id)}
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)]" />
                      <span className="min-w-0 truncate text-[15px] font-normal leading-none">
                        {project.name}
                      </span>
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <ChevronRight
                        className={[
                            "h-3.5 w-3.5 text-[var(--color-text-secondary)] transition-transform duration-200",
                          project.isExpanded ? "rotate-90" : "rotate-0",
                        ].join(" ")}
                        />
                      </span>
                    </button>

                    <div
                      className={[
                        "flex shrink-0 items-center gap-1 overflow-hidden transition-[width,opacity] duration-150 ease-out",
                        menuKey === projectMenuKey
                          ? "w-[4.5rem] opacity-100"
                          : "w-0 opacity-0 group-hover/project:w-[4.5rem] group-hover/project:opacity-100",
                      ].join(" ")}
                    >
                      <button
                        aria-label="Project options"
                        className="rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-subtle)] hover:text-[var(--color-text)]"
                        data-sidebar-menu-trigger
                        onClick={(event) => {
                          if (menuKey === projectMenuKey) {
                            setMenu(null);
                            return;
                          }

                          openAnchoredMenu(projectMenuKey, event.currentTarget);
                        }}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>

                      <button
                        aria-label="Create session"
                        className="rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-subtle)] hover:text-[var(--color-text)]"
                        onClick={() => createSession(project.id)}
                      >
                        <SquarePen className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {renderFloatingMenu(projectMenuKey, [
                    {
                      icon: <Copy className="h-4 w-4" />,
                      label: "Copy path",
                      onSelect: async () => {
                        await copyText(project.rootPath);
                      },
                    },
                    {
                      danger: true,
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Remove project",
                      onSelect: () => {
                        setDialog({
                          type: "remove-project",
                          projectId: project.id,
                          projectName: project.name,
                        });
                      },
                    },
                  ])}

                  <div
                    className={[
                      "grid transition-all duration-250 ease-out",
                      project.isExpanded ? "mt-0.5 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0",
                    ].join(" ")}
                  >
                    <div
                      className={[
                        "min-h-0",
                        project.isExpanded ? "overflow-visible" : "overflow-hidden",
                      ].join(" ")}
                    >
                      <div
                        className={[
                          "space-y-0.5 pl-4 transition-all duration-250 ease-out",
                          project.isExpanded ? "translate-y-0 pt-0.5" : "-translate-y-1 pt-0",
                        ].join(" ")}
                      >
                        {draftSession ? (
                          <div
                            className={[
                              "group/session relative flex min-w-0 items-center gap-1",
                              menuKey === `${project.id}:${draftSession.id}` ? "z-20" : "",
                            ].join(" ")}
                            onDoubleClick={(event) => {
                              openContextMenu(`${project.id}:${draftSession.id}`, event.clientX, event.clientY);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              openContextMenu(`${project.id}:${draftSession.id}`, event.clientX, event.clientY);
                            }}
                          >
                            <div
                              className={[
                                "flex min-w-0 w-0 flex-1 items-center overflow-hidden rounded-xl transition",
                                isDraftActive
                                  ? "bg-[var(--color-panel-active)]"
                                  : "hover:bg-[var(--color-panel-hover)]",
                              ].join(" ")}
                            >
                              <button
                                className={[
                                  "min-w-0 w-0 flex-1 overflow-hidden rounded-xl px-3 py-1.5 text-left transition",
                                  isDraftActive
                                    ? "text-[var(--color-text)]"
                                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                                ].join(" ")}
                                onClick={() => {
                                  if (draftSession) {
                                    selectSession(project.id, draftSession.id);
                                  }
                                }}
                              >
                                <span className="block truncate text-[15px] font-normal leading-[1.1]">
                                  {draftSession?.title ?? "New session"}
                                </span>
                              </button>
                              <div className="relative ml-auto mr-2 h-8 w-8 shrink-0">
                                <button
                                  aria-label="Session options"
                                  className={[
                                    "absolute inset-0 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
                                    menuKey === `${project.id}:${draftSession.id}`
                                      ? "opacity-100"
                                      : "opacity-0 group-hover/session:opacity-100",
                                  ].join(" ")}
                                  data-sidebar-menu-trigger
                                  onClick={(event) => {
                                    const draftSessionMenuKey = `${project.id}:${draftSession.id}`;

                                    if (menuKey === draftSessionMenuKey) {
                                      setMenu(null);
                                      return;
                                    }

                                    openAnchoredMenu(draftSessionMenuKey, event.currentTarget);
                                  }}
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>

                            {renderFloatingMenu(`${project.id}:${draftSession.id}`, [
                              {
                                icon: <Pencil className="h-4 w-4" />,
                                label: "Rename session",
                                onSelect: () => {
                                  setDialog({
                                    type: "rename-session",
                                    projectId: project.id,
                                    sessionId: draftSession.id,
                                    value: draftSession.title,
                                  });
                                },
                              },
                              {
                                danger: true,
                                icon: <Trash2 className="h-4 w-4" />,
                                label: "Delete session",
                                onSelect: () => {
                                  deleteDraftSession(project.id);
                                },
                              },
                            ])}
                          </div>
                        ) : null}

                        {project.sessions.map((session) => {
                          const isActive =
                            project.id === selectedProjectId && session.id === selectedSessionId;
                          const sessionMenuKey = `${project.id}:${session.id}`;
                          const sessionTileState = sessionStreamErrors[session.id]
                            ? "error"
                            : pendingToolApprovalsBySessionId[session.id]
                              ? "waiting_approval"
                              : sendingSessionIds.includes(session.id)
                                ? "running"
                                : null;

                          return (
                            <div
                              className={[
                                "group/session relative flex min-w-0 items-center gap-1",
                                menuKey === sessionMenuKey ? "z-20" : "",
                              ].join(" ")}
                              onDoubleClick={(event) => {
                                openContextMenu(sessionMenuKey, event.clientX, event.clientY);
                              }}
                              key={session.id}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                openContextMenu(sessionMenuKey, event.clientX, event.clientY);
                              }}
                            >
                              <div
                                className={[
                                  "flex min-w-0 w-0 flex-1 items-center overflow-hidden rounded-xl transition",
                                  isActive ? "bg-[var(--color-panel-active)]" : "hover:bg-[var(--color-panel-hover)]",
                                ].join(" ")}
                              >
                                <button
                                  className={[
                                    "min-w-0 w-0 flex-1 overflow-hidden rounded-xl px-3 py-1.5 text-left transition",
                                    isActive
                                      ? "text-[var(--color-text)]"
                                      : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                                  ].join(" ")}
                                  onClick={() => selectSession(project.id, session.id)}
                                >
                                  <span className="block truncate text-[15px] font-normal leading-[1.1]">
                                    {session.title}
                                  </span>
                                </button>
                                <div className="relative ml-auto mr-2 h-8 w-8 shrink-0">
                                  <span
                                    aria-label={
                                      sessionTileState === "error"
                                        ? "Session failed"
                                        : sessionTileState === "waiting_approval"
                                          ? "Waiting for approval"
                                          : sessionTileState === "running"
                                            ? "Session running"
                                            : undefined
                                    }
                                    className={[
                                      "pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-[var(--color-text-tertiary)] transition-opacity",
                                      menuKey === sessionMenuKey || (isActive && !sessionTileState)
                                        ? "opacity-0"
                                        : "opacity-100 group-hover/session:opacity-0",
                                    ].join(" ")}
                                    role={sessionTileState ? "status" : undefined}
                                    title={
                                      sessionTileState === "error"
                                        ? "Session failed"
                                        : sessionTileState === "waiting_approval"
                                          ? "Waiting for approval"
                                          : sessionTileState === "running"
                                            ? "Session running"
                                            : undefined
                                    }
                                  >
                                    {sessionTileState === "error" ? (
                                      <CircleX className="h-[13px] w-[13px] text-red-500" />
                                    ) : sessionTileState === "waiting_approval" ? (
                                      <CircleAlert className="h-[13px] w-[13px] text-red-500" />
                                    ) : sessionTileState === "running" ? (
                                      <LoaderCircle className="h-[13px] w-[13px] animate-spin" />
                                    ) : (
                                      session.updatedAtLabel
                                    )}
                                  </span>
                                  <button
                                    aria-label="Session options"
                                    className={[
                                      "absolute inset-0 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
                                      menuKey === sessionMenuKey || (isActive && !sessionTileState)
                                        ? "opacity-100"
                                        : "opacity-0 group-hover/session:opacity-100",
                                    ].join(" ")}
                                    data-sidebar-menu-trigger
                                    onClick={(event) => {
                                      if (menuKey === sessionMenuKey) {
                                        setMenu(null);
                                        return;
                                      }

                                      openAnchoredMenu(sessionMenuKey, event.currentTarget);
                                    }}
                                  >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>

                              {renderFloatingMenu(sessionMenuKey, [
                                {
                                  icon: <Pencil className="h-4 w-4" />,
                                  label: "Rename session",
                                  onSelect: () => {
                                    setDialog({
                                      type: "rename-session",
                                      projectId: project.id,
                                      sessionId: session.id,
                                      value: session.title,
                                    });
                                  },
                                },
                                {
                                  danger: true,
                                  icon: <Trash2 className="h-4 w-4" />,
                                  label: "Delete session",
                                  onSelect: () => {
                                    setDialog({
                                      type: "delete-session",
                                      projectId: project.id,
                                      sessionId: session.id,
                                      sessionTitle: session.title,
                                    });
                                  },
                                },
                              ])}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
                })}
              </div>
            </>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-3 py-3">
          <button
            className="flex w-full items-center gap-2.5 rounded-2xl px-1 py-1 text-left transition hover:bg-[var(--color-panel-hover)]"
            data-sidebar-menu-trigger
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();

              if (menuKey === "settings") {
                setMenu(null);
                setIsThemeExpanded(false);
                return;
              }

              const sidebar = event.currentTarget.closest("aside");
              const sidebarRect = sidebar?.getBoundingClientRect();

              setMenu({
                key: "settings",
                x: sidebarRect ? sidebarRect.left + 14 : rect.left,
                y: rect.top - 12,
                align: "start",
                vertical: "above",
                width: sidebarRect ? Math.max(sidebarRect.width - 28, 248) : 248,
              });
            }}
          >
          <LogoMark className="h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-normal text-[var(--color-text)]">Wizzle</p>
            <p className="text-[12px] text-[var(--color-text-tertiary)]">Click for settings</p>
          </div>
          </button>
        </div>
      </aside>

      {menuKey === "settings" && menu ? createPortal(
        <div
          className="fixed z-[300] rounded-[24px] border border-[var(--color-border-strong)] bg-[var(--color-panel)] p-3 shadow-[0_18px_40px_rgba(0,0,0,0.22)] backdrop-blur-xl"
          data-sidebar-menu
          style={{
            left: menu.x,
            top: menu.y,
            transform: "translateY(-100%)",
            width: menu.width,
          }}
        >
          <div className="flex items-center gap-3 rounded-[18px] px-3 py-2.5">
            <LogoMark className="h-7 w-7" />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-normal leading-none tracking-normal text-[var(--color-text)]">
                Wizzle
              </p>
              <p className="mt-1 truncate text-[12px] leading-none text-[var(--color-text-tertiary)]">
                Settings
              </p>
            </div>
          </div>
          <div className="mx-3 my-2 h-px bg-[var(--color-border)]" />
          <button
            className="flex w-full items-center justify-between rounded-[18px] px-3 py-2.5 text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
            onClick={() => setIsThemeExpanded((value) => !value)}
          >
            <span className="flex items-center gap-3">
              <Laptop className="h-4 w-4" />
              <span className="text-[13px] font-normal leading-none tracking-normal">Theme</span>
            </span>
            <ChevronDown
              className={[
                "h-3.5 w-3.5 transition-transform",
                isThemeExpanded ? "rotate-180" : "rotate-0",
              ].join(" ")}
            />
          </button>
          <div
            className={[
              "grid transition-all duration-250 ease-out",
              isThemeExpanded ? "mt-1 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0",
            ].join(" ")}
          >
            <div className={["min-h-0", isThemeExpanded ? "overflow-visible" : "overflow-hidden"].join(" ")}>
              <div
                className={[
                  "space-y-1 px-2 pb-1 transition-all duration-250 ease-out",
                  isThemeExpanded ? "translate-y-0 pt-0" : "-translate-y-1 pt-0",
                ].join(" ")}
              >
                {([
                  { icon: Laptop, label: "System", value: "system" },
                  { icon: Sun, label: "Light", value: "light" },
                  { icon: Moon, label: "Dark", value: "dark" },
                ] as const).map((option) => {
                  const Icon = option.icon;
                  const isActive = themePreference === option.value;

                  return (
                    <button
                      className="flex w-full items-center justify-between rounded-[16px] px-3 py-2 text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
                      key={option.value}
                      onClick={() => {
                        applyThemePreference(option.value);
                        setThemePreference(option.value);
                      }}
                    >
                      <span className="flex items-center gap-3">
                        <Icon className="h-3.5 w-3.5" />
                        <span className="text-[13px] font-normal leading-none tracking-normal">
                          {option.label}
                        </span>
                      </span>
                      <span
                        className={[
                          "flex h-4 w-4 items-center justify-center rounded-full border",
                          isActive
                            ? "border-[var(--color-text)] text-[var(--color-text)]"
                            : "border-[var(--color-border-strong)] text-transparent",
                        ].join(" ")}
                      >
                        <Check className="h-2.5 w-2.5" />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="mx-3 my-2 h-px bg-[var(--color-border)]" />
          <button
            className="flex w-full items-center gap-3 rounded-[18px] px-3 py-2.5 text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
            onClick={() => {
              setMenu(null);
              setIsThemeExpanded(false);
              onOpenProviders?.();
            }}
          >
            <Settings className="h-4 w-4" />
            <span className="text-[13px] font-normal leading-none tracking-normal">Providers</span>
          </button>
          <div className="mx-3 my-2 h-px bg-[var(--color-border)]" />
          <button
            className="flex w-full items-center gap-3 rounded-[18px] px-3 py-2.5 text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
            onClick={() => {
              setMenu(null);
              setIsThemeExpanded(false);
              setDialog({ type: "confirm-exit" });
            }}
          >
            <Power className="h-4 w-4" />
            <span className="text-[13px] font-normal leading-none tracking-normal">Exit Wizzle</span>
          </button>
        </div>,
        document.body,
      ) : null}

      {dialog?.type === "confirm-exit" ? (
        <AppDialog
          actions={
            <>
              <button
                className="h-10 rounded-full px-4 text-[14px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={closeDialog}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-[14px] font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)]"
                onClick={async () => {
                  closeDialog();
                  await getCurrentWindow().close();
                }}
              >
                Exit
              </button>
            </>
          }
          description="Close the Wizzle desktop app?"
          onClose={closeDialog}
          title="Exit Wizzle?"
        />
      ) : null}

      {dialog?.type === "rename-session" ? (
        <AppDialog
          actions={
            <>
              <button
                className="h-10 rounded-full px-4 text-[14px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={closeDialog}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-full bg-[var(--color-accent)] px-4 text-[14px] font-medium text-[var(--color-accent-foreground)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!dialog.value.trim()}
                onClick={() => {
                  if (isDraftSessionId(dialog.sessionId)) {
                    renameDraftSession(dialog.projectId, dialog.value);
                  } else {
                    renameSession(dialog.projectId, dialog.sessionId, dialog.value);
                  }
                  closeDialog();
                }}
              >
                Save
              </button>
            </>
          }
          description="Update the session name shown in the sidebar."
          onClose={closeDialog}
          title="Rename session"
        >
          <input
            autoFocus
            className="h-11 w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-muted)] px-4 text-[14px] text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-strong)]"
            onChange={(event) => setDialog({ ...dialog, value: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && dialog.value.trim()) {
                if (isDraftSessionId(dialog.sessionId)) {
                  renameDraftSession(dialog.projectId, dialog.value);
                } else {
                  renameSession(dialog.projectId, dialog.sessionId, dialog.value);
                }
                closeDialog();
              }
            }}
            placeholder="Session title"
            value={dialog.value}
          />
        </AppDialog>
      ) : null}

      {dialog?.type === "delete-session" ? (
        <AppDialog
          actions={
            <>
              <button
                className="h-10 rounded-full px-4 text-[14px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                onClick={closeDialog}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-full bg-[var(--color-danger)] px-4 text-[14px] font-medium text-white transition hover:opacity-90"
                onClick={() => {
                  deleteSession(dialog.projectId, dialog.sessionId);
                  closeDialog();
                }}
              >
                Delete
              </button>
            </>
          }
          description={`Delete "${dialog.sessionTitle}" from this project?`}
          onClose={closeDialog}
          title="Delete session"
        />
      ) : null}

      {dialog?.type === "remove-project" ? (
        <AppDialog
          busy={isRemovingProject}
          actions={
            <>
              <button
                className="h-10 rounded-full px-4 text-[14px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                disabled={isRemovingProject}
                onClick={closeDialog}
              >
                Cancel
              </button>
              <button
                className="h-10 rounded-full bg-[var(--color-danger)] px-4 text-[14px] font-medium text-white transition hover:opacity-90"
                disabled={isRemovingProject}
                onClick={async () => {
                  setIsRemovingProject(true);

                  try {
                    const snapshot = await removeProjectById(dialog.projectId);
                    hydrateWorkspace(snapshot);
                    closeDialog();
                  } finally {
                    setIsRemovingProject(false);
                  }
                }}
              >
                {isRemovingProject ? "Removing..." : "Remove"}
              </button>
            </>
          }
          description={`Remove "${dialog.projectName}" from the sidebar?`}
          onClose={closeDialog}
          title="Remove project"
        />
      ) : null}
    </>
  );
}
