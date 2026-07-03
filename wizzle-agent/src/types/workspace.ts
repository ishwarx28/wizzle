export type MessageRole = "user" | "assistant";
export type FilePreviewKind = "markdown" | "text" | "image" | "other";
export type PermissionMode = "manual-approve" | "full-access";
export type ModelId = "wizzle-1-thinking" | "wizzle-1-thinking-max";

export interface PreviewFile {
  id: string;
  name: string;
  kind: FilePreviewKind;
  path: string;
  summary: string;
  content?: string;
  language?: string;
  imageSrc?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAtLabel: string;
  linkedFileIds?: string[];
}

export interface Session {
  id: string;
  title: string;
  updatedAtLabel: string;
  messages: Message[];
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  isExpanded: boolean;
  sessions: Session[];
}

export interface AccountProfile {
  email: string;
  name: string;
  avatarLabel: string;
  avatarUrl?: string | null;
  plan: "Free" | "Pro" | "Plus";
}
