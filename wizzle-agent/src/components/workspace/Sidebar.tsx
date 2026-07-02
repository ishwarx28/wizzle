import { useState } from "react";
import {
  ChevronRight,
  Copy,
  Folder,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  SquarePen,
  Trash2,
} from "lucide-react";

import { useScrollActivity } from "../../hooks/use-scroll-activity";
import { useWorkspaceStore } from "../../store/workspace-store";
import { copyText } from "../../utils/clipboard";
import { LogoMark } from "../common/LogoMark";

export function Sidebar() {
  const account = useWorkspaceStore((state) => state.account);
  const projects = useWorkspaceStore((state) => state.projects);
  const selectedProjectId = useWorkspaceStore((state) => state.selectedProjectId);
  const selectedSessionId = useWorkspaceStore((state) => state.selectedSessionId);
  const addProject = useWorkspaceStore((state) => state.addProject);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const deleteSession = useWorkspaceStore((state) => state.deleteSession);
  const removeProject = useWorkspaceStore((state) => state.removeProject);
  const renameSession = useWorkspaceStore((state) => state.renameSession);
  const selectSession = useWorkspaceStore((state) => state.selectSession);
  const toggleProjectExpanded = useWorkspaceStore((state) => state.toggleProjectExpanded);
  const toggleSidebar = useWorkspaceStore((state) => state.toggleSidebar);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const { handleScrollActivity, isScrolling } = useScrollActivity();

  return (
    <aside className="flex h-full w-full flex-col border-r border-[var(--color-border)] bg-[var(--color-panel-sidebar)]">
      <div
        className="app-titlebar-region app-titlebar-sidebar flex items-center justify-between pb-2 pr-4 pt-4"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-3">
          <LogoMark className="h-7 w-7 object-contain" />
          <div>
            <p className="text-sm font-semibold text-[var(--color-text)]">Wizzle</p>
          </div>
        </div>
        <button
          aria-label="Collapse sidebar"
          className="rounded-xl p-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          onClick={toggleSidebar}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="px-3">
        <button
          className="flex h-8 w-full items-center gap-3 rounded-lg px-2 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          onClick={addProject}
        >
          <FolderPlus className="h-4 w-4" />
          <span className="text-[15px] font-normal leading-[1.1]">Add new project</span>
        </button>
      </div>

      <div
        className={[
          "auto-hide-scrollbar mt-2 flex-1 overflow-y-auto px-2 pb-4",
          isScrolling ? "is-scrolling" : "",
        ].join(" ")}
        onScroll={handleScrollActivity}
      >
        <div className="mb-1.5 mt-1 px-2 text-[13px] font-medium text-[var(--color-text-tertiary)]">
          Projects
        </div>
        <div className="space-y-1">
          {projects.map((project) => {
            return (
            <div className="px-1 py-0.5" key={project.id}>
              <div
                className={[
                  "group/project flex items-center gap-1 rounded-2xl px-1 py-0.5 transition",
                  "hover:bg-[var(--color-panel-hover)]",
                ].join(" ")}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-[var(--color-text-secondary)]"
                  onClick={() => toggleProjectExpanded(project.id)}
                >
                  <Folder className="h-3.25 w-3.25 shrink-0 text-[var(--color-text-secondary)]" />
                  <span className="truncate text-[15px] font-normal leading-[1.1]">{project.name}</span>
                  <ChevronRight
                    className={[
                      "h-3.25 w-3.25 shrink-0 text-[var(--color-text-secondary)] opacity-0 transition-all duration-200 group-hover/project:opacity-100",
                      project.isExpanded ? "rotate-90" : "rotate-0",
                    ].join(" ")}
                  />
                </button>
                <div className="relative">
                  <button
                    aria-label="Project options"
                    className={[
                      "rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-subtle)] hover:text-[var(--color-text)]",
                      menuKey === project.id ? "opacity-100" : "opacity-0 group-hover/project:opacity-100",
                    ].join(" ")}
                    onClick={() => setMenuKey(menuKey === project.id ? null : project.id)}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                  {menuKey === project.id ? (
                    <div className="absolute right-0 z-20 mt-2 w-44 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-elevated)] p-1">
                      <button
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
                        onClick={async () => {
                          await copyText(project.rootPath);
                          setMenuKey(null);
                        }}
                      >
                        <Copy className="h-4 w-4" />
                        Copy path
                      </button>
                      <button
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--color-danger)] transition hover:bg-[var(--color-panel-hover)]"
                        onClick={() => {
                          removeProject(project.id);
                          setMenuKey(null);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove project
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  aria-label="Create session"
                  className={[
                    "rounded-lg p-1.5 text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-subtle)] hover:text-[var(--color-text)]",
                    "opacity-0 group-hover/project:opacity-100",
                  ].join(" ")}
                  onClick={() => createSession(project.id)}
                >
                  <SquarePen className="h-3.5 w-3.5" />
                </button>
              </div>

              <div
                className={[
                  "grid transition-all duration-250 ease-out",
                  project.isExpanded ? "mt-0.5 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0",
                ].join(" ")}
              >
                <div className="min-h-0 overflow-hidden">
                  <div
                    className={[
                      "space-y-0.5 pl-4 transition-all duration-250 ease-out",
                      project.isExpanded ? "translate-y-0 pt-0.5" : "-translate-y-1 pt-0",
                    ].join(" ")}
                  >
                  {project.sessions.map((session) => {
                    const isActive =
                      project.id === selectedProjectId && session.id === selectedSessionId;
                    const sessionMenuKey = `${project.id}:${session.id}`;

                    return (
                      <div className="group/session flex items-center gap-1" key={session.id}>
                        <div
                          className={[
                            "flex min-w-0 flex-1 items-center rounded-xl transition",
                            isActive ? "bg-[var(--color-panel-active)]" : "hover:bg-[var(--color-panel-hover)]",
                          ].join(" ")}
                        >
                          <button
                            className={[
                              "min-w-0 flex-1 rounded-xl px-3 py-1.5 text-left transition",
                              isActive
                                ? "text-[var(--color-text)]"
                                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                            ].join(" ")}
                            onClick={() => selectSession(project.id, session.id)}
                          >
                            <span className="block truncate text-[15px] font-normal leading-[1.1]">{session.title}</span>
                          </button>
                          <div className="relative ml-auto mr-2 h-8 w-8 shrink-0">
                            <span
                              className={[
                                "pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-[var(--color-text-tertiary)] transition-opacity",
                                menuKey === sessionMenuKey
                                  ? "opacity-0"
                                  : "opacity-100 group-hover/session:opacity-0",
                              ].join(" ")}
                            >
                              {session.updatedAtLabel}
                            </span>
                            <button
                              aria-label="Session options"
                              className={[
                                "absolute inset-0 flex items-center justify-center rounded-lg text-[var(--color-text-secondary)] transition hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]",
                                menuKey === sessionMenuKey
                                  ? "opacity-100"
                                  : "opacity-0 group-hover/session:opacity-100",
                              ].join(" ")}
                              onClick={() =>
                                setMenuKey(menuKey === sessionMenuKey ? null : sessionMenuKey)
                              }
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          {menuKey === sessionMenuKey ? (
                            <div className="absolute right-0 z-20 mt-2 w-44 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-elevated)] p-1">
                              <button
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--color-text)] transition hover:bg-[var(--color-panel-hover)]"
                                onClick={() => {
                                  renameSession(project.id, session.id);
                                  setMenuKey(null);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                                Rename session
                              </button>
                              <button
                                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--color-danger)] transition hover:bg-[var(--color-panel-hover)]"
                                onClick={() => {
                                  deleteSession(project.id, session.id);
                                  setMenuKey(null);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete session
                              </button>
                            </div>
                          ) : null}
                          </div>
                        </div>
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
      </div>

      <div className="border-t border-[var(--color-border)] px-3 py-3">
        <div className="flex items-center gap-2.5 px-1 py-1">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-avatar-bg)] text-[12px] font-semibold text-white">
            {account.avatarLabel}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-normal text-[var(--color-text)]">{account.name}</p>
            <p className="text-[12px] text-[var(--color-text-tertiary)]">{account.plan}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
