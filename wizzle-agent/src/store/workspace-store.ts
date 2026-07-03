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
  selectedSessionId: string | null;
  draftSessionProjectId: string | null;
  activeFileId: string | null;
  openedFileIds: string[];
  isSidebarOpen: boolean;
  isFilePanelOpen: boolean;
  modelId: ModelId;
  permissionMode: PermissionMode;
  addProject: (projectName: string) => void;
  toggleProjectExpanded: (projectId: string) => void;
  createSession: (projectId: string) => void;
  renameSession: (projectId: string, sessionId: string, title: string) => void;
  deleteSession: (projectId: string, sessionId: string) => void;
  removeProject: (projectId: string) => void;
  selectSession: (projectId: string, sessionId: string) => void;
  openFile: (fileId: string) => void;
  closeFile: (fileId: string) => void;
  toggleSidebar: () => void;
  toggleFilePanel: () => void;
  setModelId: (modelId: ModelId) => void;
  setPermissionMode: (permissionMode: PermissionMode) => void;
  setAccount: (account: AccountProfile) => void;
  sendPrompt: (prompt: string, attachments?: PreviewFile[]) => void;
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
  email: "mrdev.288@gmail.com",
  name: "Ishwar Meghwal",
  avatarLabel: "IM",
  avatarUrl: null,
  plan: "Free",
};

const DRAFT_SESSION_TITLE = "New session";

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

function createAttachmentFallback(attachments: PreviewFile[]) {
  return attachments.length === 1 ? "Attached 1 file." : `Attached ${attachments.length} files.`;
}

function createUserMessage(prompt: string, attachments: PreviewFile[]): Message {
  const normalizedPrompt = prompt.trim();

  return {
    id: `message-user-${Date.now()}`,
    role: "user",
    content: normalizedPrompt || createAttachmentFallback(attachments),
    createdAtLabel: "just now",
    linkedFileIds: attachments.map((attachment) => attachment.id),
  };
}

function createAssistantReplyWithAttachments(prompt: string, attachments: PreviewFile[]): Message {
  if (attachments.length === 0) {
    return createAssistantReply(prompt);
  }

  const normalizedPrompt = prompt.trim();
  const attachmentLine =
    attachments.length === 1
      ? "I kept your attached file available in the preview panel."
      : `I kept your ${attachments.length} attached files available in the preview panel.`;

  return {
    id: `message-assistant-${Date.now()}`,
    role: "assistant",
    createdAtLabel: "just now",
    content: normalizedPrompt
      ? `Here is a mocked phase 1 response for:

> ${normalizedPrompt}

${attachmentLine}`
      : `${attachmentLine}

You can open any of them from the message and inspect them in the right panel.`,
  };
}

function withSelectedSession<T>(
  projects: Project[],
  selectedProjectId: string,
  selectedSessionId: string | null,
  updater: (projectIndex: number, sessionIndex: number, nextProjects: Project[]) => T,
): T | null {
  if (!selectedSessionId) {
    return null;
  }

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
  draftSessionProjectId: null,
  activeFileId: "file-architecture",
  openedFileIds: ["file-architecture"],
  isSidebarOpen: true,
  isFilePanelOpen: true,
  modelId: "wizzle-1-thinking",
  permissionMode: "full-access",
  addProject: (projectName) =>
    set((state) => {
      const normalizedName = projectName.trim();

      if (!normalizedName) {
        return state;
      }

      const newProject: Project = {
        id: `project-${Date.now()}`,
        name: normalizedName,
        rootPath: `/mock/projects/${normalizedName.replace(/ /g, "-").toLowerCase()}`,
        isExpanded: true,
        sessions: [
          {
            id: `session-${Date.now()}`,
            title: DRAFT_SESSION_TITLE,
            updatedAtLabel: "now",
            messages: [],
          },
        ],
      };

      return {
        projects: [newProject, ...state.projects],
        selectedProjectId: newProject.id,
        selectedSessionId: newProject.sessions[0].id,
        draftSessionProjectId: null,
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
      return {
        projects: state.projects.map((project) =>
          project.id === projectId ? { ...project, isExpanded: true } : project,
        ),
        selectedProjectId: projectId,
        selectedSessionId: null,
        draftSessionProjectId: projectId,
      };
    }),
  renameSession: (projectId, sessionId, title) =>
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

            const normalizedTitle = title.trim();
            return normalizedTitle ? { ...session, title: normalizedTitle } : session;
          }),
        };
      }),
    })),
  deleteSession: (projectId, sessionId) =>
    set((state) => {
      const project = state.projects.find((entry) => entry.id === projectId);

      if (!project || project.sessions.length <= 1) {
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
            draftSessionProjectId:
              state.draftSessionProjectId === projectId ? fallbackProject.id : state.draftSessionProjectId,
          }
        : state;
    }),
  removeProject: (projectId) =>
    set((state) => {
      if (state.projects.length <= 1) {
        return state;
      }

      const nextProjects = state.projects.filter((project) => project.id !== projectId);
      const selectedProjectWasRemoved = state.selectedProjectId === projectId;
      const fallbackProject = nextProjects[0];

      return selectedProjectWasRemoved && fallbackProject
        ? {
            projects: nextProjects,
            selectedProjectId: fallbackProject.id,
            selectedSessionId: fallbackProject.sessions[0]?.id ?? null,
            draftSessionProjectId: null,
          }
        : {
            projects: nextProjects,
            draftSessionProjectId:
              state.draftSessionProjectId === projectId ? null : state.draftSessionProjectId,
          };
    }),
  selectSession: (projectId, sessionId) =>
    set({
      selectedProjectId: projectId,
      selectedSessionId: sessionId,
      draftSessionProjectId: null,
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
  setAccount: (account) => set({ account }),
  sendPrompt: (prompt, attachments = []) =>
    set((state) => {
      const content = prompt.trim();

      if (!content && attachments.length === 0) {
        return state;
      }

      const nextPreviewFiles = attachments.length > 0
        ? [...state.previewFiles, ...attachments.filter((attachment) => !state.previewFiles.some((file) => file.id === attachment.id))]
        : state.previewFiles;

      if (state.draftSessionProjectId) {
        const projectIndex = state.projects.findIndex(
          (project) => project.id === state.draftSessionProjectId,
        );

        if (projectIndex === -1) {
          return state;
        }

        const nextProjects = structuredClone(state.projects);
        const userMessage = createUserMessage(content, attachments);
        const nextSessionId = `session-${Date.now()}`;

        nextProjects[projectIndex].sessions.unshift({
          id: nextSessionId,
          title: DRAFT_SESSION_TITLE,
          updatedAtLabel: "now",
          messages: [userMessage, createAssistantReplyWithAttachments(content, attachments)],
        });
        nextProjects[projectIndex].isExpanded = true;

        return {
          projects: nextProjects,
          previewFiles: nextPreviewFiles,
          selectedProjectId: nextProjects[projectIndex].id,
          selectedSessionId: nextSessionId,
          draftSessionProjectId: null,
        };
      }

      const result = withSelectedSession(
        state.projects,
        state.selectedProjectId,
        state.selectedSessionId,
        (projectIndex, sessionIndex, nextProjects) => {
          const userMessage = createUserMessage(content, attachments);

          nextProjects[projectIndex].sessions[sessionIndex].messages.push(userMessage);
          nextProjects[projectIndex].sessions[sessionIndex].messages.push(
            createAssistantReplyWithAttachments(content, attachments),
          );
          nextProjects[projectIndex].sessions[sessionIndex].updatedAtLabel = "now";

          return nextProjects;
        },
      );

      return result
        ? { projects: result, previewFiles: nextPreviewFiles, draftSessionProjectId: null }
        : state;
    }),
}));
