import { create } from "zustand";

import logoSrc from "../assets/brand/wizzle-logo.png";
import type {
  AccountProfile,
  Message,
  ModelId,
  PermissionMode,
  PreviewFile,
  Project,
} from "../types/workspace";

interface WorkspaceState {
  account: AccountProfile;
  projects: Project[];
  previewFiles: PreviewFile[];
  selectedProjectId: string;
  selectedSessionId: string;
  activeFileId: string | null;
  openedFileIds: string[];
  isSidebarOpen: boolean;
  isFilePanelOpen: boolean;
  modelId: ModelId;
  permissionMode: PermissionMode;
  addProject: () => void;
  toggleProjectExpanded: (projectId: string) => void;
  createSession: (projectId: string) => void;
  renameSession: (projectId: string, sessionId: string) => void;
  deleteSession: (projectId: string, sessionId: string) => void;
  removeProject: (projectId: string) => void;
  selectSession: (projectId: string, sessionId: string) => void;
  openFile: (fileId: string) => void;
  closeFile: (fileId: string) => void;
  toggleSidebar: () => void;
  toggleFilePanel: () => void;
  setModelId: (modelId: ModelId) => void;
  setPermissionMode: (permissionMode: PermissionMode) => void;
  sendPrompt: (prompt: string) => void;
}

const previewFiles: PreviewFile[] = [
  {
    id: "file-architecture",
    name: "architecture.md",
    kind: "markdown",
    path: "/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/architecture.md",
    summary: "High-level app architecture and implementation phases.",
    content: `# Wizzle Agent

## Goal

Cross-platform desktop app for coding with AI.

## MVP UI Notes

- Three-column layout
- Local projects and sessions
- Composer with permission mode and model picker
- Right-side file preview for markdown, images, and text

## Phase 1

Build the app shell, mock state, and all core surfaces before wiring real auth, filesystem access, and proxy streaming.`,
  },
  {
    id: "file-login-flow",
    name: "firebase-auth-notes.txt",
    kind: "text",
    path: "/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/docs/firebase-auth-notes.txt",
    summary: "Placeholder notes for the upcoming auth phase.",
    language: "text",
    content: `MVP auth surface:
- Email + password
- Auto-create account if email does not exist
- Require verified email before entering the app
- Password reset via email
- Continue with Google`,
  },
  {
    id: "file-logo",
    name: "wizzle-logo.png",
    kind: "image",
    path: "/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/src/assets/brand/wizzle-logo.png",
    summary: "Primary brand mark used for favicon and empty states.",
    imageSrc: logoSrc,
  },
  {
    id: "file-harness",
    name: "harness.ts",
    kind: "text",
    path: "/Users/mrdev.288/StudioProjects/wizzle/wizzle-agent/src/lib/harness.ts",
    summary: "Mock harness shape for the phase 3 tool surface.",
    language: "ts",
    content: `export type BuiltInTool = "read" | "write" | "edit" | "bash";

export interface HarnessContext {
  projectRoot: string;
  permissionMode: "ask" | "full-access";
}

export function listBuiltInTools(): BuiltInTool[] {
  return ["read", "write", "edit", "bash"];
}`,
  },
];

const initialProjects: Project[] = [
  {
    id: "project-wizzle",
    name: "wizzle",
    rootPath: "/Users/mrdev.288/StudioProjects/wizzle",
    isExpanded: true,
    sessions: [
      {
        id: "session-phase1",
        title: "Phase 1 frontend shell",
        updatedAtLabel: "12m",
        messages: [
          {
            id: "message-user-1",
            role: "user",
            content:
              "Build the three required phase 1 pages and keep the layout close to the reference screenshots.",
            createdAtLabel: "10:04 PM",
          },
          {
            id: "message-assistant-1",
            role: "assistant",
            content: `I mapped the app into three surfaces:

- auth pages for login and password reset
- a central chat workspace with a structured composer
- a right-side preview drawer for opened files

The files below are already attached to the workspace for quick review.`,
            createdAtLabel: "10:05 PM",
            linkedFileIds: ["file-architecture", "file-logo", "file-harness"],
          },
        ],
      },
      {
        id: "session-empty",
        title: "New session",
        updatedAtLabel: "now",
        messages: [],
      },
    ],
  },
  {
    id: "project-tradesocial",
    name: "TradeSocial",
    rootPath: "/Users/mrdev.288/StudioProjects/TradeSocial",
    isExpanded: false,
    sessions: [
      {
        id: "session-audit",
        title: "Sidebar redesign ideas",
        updatedAtLabel: "1h",
        messages: [],
      },
    ],
  },
  {
    id: "project-oviioo",
    name: "oviioo",
    rootPath: "/Users/mrdev.288/StudioProjects/Personal/oviioo",
    isExpanded: false,
    sessions: [
      {
        id: "session-feed",
        title: "Feed polish",
        updatedAtLabel: "2d",
        messages: [],
      },
    ],
  },
];

const account: AccountProfile = {
  name: "Ishwar Meghwal",
  avatarLabel: "IM",
  plan: "Plus",
};

function createAssistantReply(prompt: string): Message {
  const normalizedPrompt = prompt.trim();

  return {
    id: `message-assistant-${Date.now()}`,
    role: "assistant",
    createdAtLabel: "just now",
    content: `Here is a mocked phase 1 response for:

> ${normalizedPrompt}

I would keep the UI inside the existing shell, preserve the device theme, and route any clicked files into the right preview panel.`,
    linkedFileIds: normalizedPrompt.toLowerCase().includes("logo")
      ? ["file-logo", "file-architecture"]
      : ["file-login-flow"],
  };
}

function withSelectedSession<T>(
  projects: Project[],
  selectedProjectId: string,
  selectedSessionId: string,
  updater: (projectIndex: number, sessionIndex: number, nextProjects: Project[]) => T,
): T | null {
  const projectIndex = projects.findIndex((project) => project.id === selectedProjectId);
  if (projectIndex === -1) {
    return null;
  }

  const sessionIndex = projects[projectIndex].sessions.findIndex(
    (session) => session.id === selectedSessionId,
  );
  if (sessionIndex === -1) {
    return null;
  }

  const nextProjects = structuredClone(projects);
  return updater(projectIndex, sessionIndex, nextProjects);
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  account,
  projects: initialProjects,
  previewFiles,
  selectedProjectId: "project-wizzle",
  selectedSessionId: "session-phase1",
  activeFileId: "file-architecture",
  openedFileIds: ["file-architecture"],
  isSidebarOpen: true,
  isFilePanelOpen: true,
  modelId: "wizzle-1-thinking",
  permissionMode: "full-access",
  addProject: () =>
    set((state) => {
      const projectNumber = state.projects.length + 1;
      const projectName = window.prompt("Project name", `Project ${projectNumber}`)?.trim();

      if (!projectName) {
        return state;
      }

      const newProject: Project = {
        id: `project-${Date.now()}`,
        name: projectName,
        rootPath: `/mock/projects/${projectName.replace(/ /g, "-").toLowerCase()}`,
        isExpanded: true,
        sessions: [
          {
            id: `session-${Date.now()}`,
            title: "New session",
            updatedAtLabel: "now",
            messages: [],
          },
        ],
      };

      return {
        projects: [newProject, ...state.projects],
        selectedProjectId: newProject.id,
        selectedSessionId: newProject.sessions[0].id,
      };
    }),
  toggleProjectExpanded: (projectId) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? { ...project, isExpanded: !project.isExpanded } : project,
      ),
    })),
  createSession: (projectId) =>
    set((state) => {
      const title = window.prompt("Session title", "New session")?.trim() || "New session";

      const nextProjects = state.projects.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        return {
          ...project,
          isExpanded: true,
          sessions: [
            {
              id: `session-${Date.now()}`,
              title,
              updatedAtLabel: "now",
              messages: [],
            },
            ...project.sessions,
          ],
        };
      });

      const nextProject = nextProjects.find((project) => project.id === projectId);
      const nextSession = nextProject?.sessions[0];

      return nextProject && nextSession
        ? {
            projects: nextProjects,
            selectedProjectId: nextProject.id,
            selectedSessionId: nextSession.id,
          }
        : state;
    }),
  renameSession: (projectId, sessionId) =>
    set((state) => ({
      projects: state.projects.map((project) => {
        if (project.id !== projectId) {
          return project;
        }

        return {
          ...project,
          sessions: project.sessions.map((session) => {
            if (session.id !== sessionId) {
              return session;
            }

            const title = window.prompt("Rename session", session.title)?.trim();
            return title ? { ...session, title } : session;
          }),
        };
      }),
    })),
  deleteSession: (projectId, sessionId) =>
    set((state) => {
      const project = state.projects.find((entry) => entry.id === projectId);

      if (!project || project.sessions.length <= 1 || !window.confirm("Delete this session?")) {
        return state;
      }

      const nextProjects = state.projects.map((entry) => {
        if (entry.id !== projectId) {
          return entry;
        }

        return {
          ...entry,
          sessions: entry.sessions.filter((session) => session.id !== sessionId),
        };
      });

      const fallbackProject = nextProjects.find((entry) => entry.id === projectId) ?? nextProjects[0];
      const fallbackSession = fallbackProject?.sessions[0];

      return fallbackProject && fallbackSession
        ? {
            projects: nextProjects,
            selectedProjectId: fallbackProject.id,
            selectedSessionId: fallbackSession.id,
          }
        : state;
    }),
  removeProject: (projectId) =>
    set((state) => {
      if (state.projects.length <= 1 || !window.confirm("Remove this project from the sidebar?")) {
        return state;
      }

      const nextProjects = state.projects.filter((project) => project.id !== projectId);
      const selectedProjectWasRemoved = state.selectedProjectId === projectId;
      const fallbackProject = nextProjects[0];

      return selectedProjectWasRemoved && fallbackProject
        ? {
            projects: nextProjects,
            selectedProjectId: fallbackProject.id,
            selectedSessionId: fallbackProject.sessions[0]?.id ?? "",
          }
        : {
            projects: nextProjects,
          };
    }),
  selectSession: (projectId, sessionId) =>
    set({
      selectedProjectId: projectId,
      selectedSessionId: sessionId,
    }),
  openFile: (fileId) =>
    set((state) => ({
      activeFileId: fileId,
      isFilePanelOpen: true,
      openedFileIds: state.openedFileIds.includes(fileId)
        ? state.openedFileIds
        : [...state.openedFileIds, fileId],
    })),
  closeFile: (fileId) =>
    set((state) => {
      const openedFileIds = state.openedFileIds.filter((entry) => entry !== fileId);
      const activeFileId =
        state.activeFileId === fileId
          ? openedFileIds[openedFileIds.length - 1] ?? null
          : state.activeFileId;

      return {
        openedFileIds,
        activeFileId,
        isFilePanelOpen: openedFileIds.length > 0 && state.isFilePanelOpen,
      };
    }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  toggleFilePanel: () =>
    set((state) => ({
      isFilePanelOpen: !state.isFilePanelOpen,
    })),
  setModelId: (modelId) => set({ modelId }),
  setPermissionMode: (permissionMode) => set({ permissionMode }),
  sendPrompt: (prompt) =>
    set((state) => {
      const content = prompt.trim();

      if (!content) {
        return state;
      }

      const result = withSelectedSession(
        state.projects,
        state.selectedProjectId,
        state.selectedSessionId,
        (projectIndex, sessionIndex, nextProjects) => {
          const userMessage: Message = {
            id: `message-user-${Date.now()}`,
            role: "user",
            content,
            createdAtLabel: "just now",
          };

          nextProjects[projectIndex].sessions[sessionIndex].messages.push(userMessage);
          nextProjects[projectIndex].sessions[sessionIndex].messages.push(createAssistantReply(content));
          nextProjects[projectIndex].sessions[sessionIndex].updatedAtLabel = "now";

          return nextProjects;
        },
      );

      return result ? { projects: result } : state;
    }),
}));
