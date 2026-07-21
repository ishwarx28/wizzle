export type RemoteDeveloperLink = {
  id: string;
  label: string;
  url: string;
};

export type RemoteDeveloper = {
  email: string;
  links: RemoteDeveloperLink[];
  name: string;
};

export type RemoteUpdate = {
  enabled: boolean;
  note: string;
  platform: "linux" | "macos" | "windows";
  status: "critical" | "normal";
  url: string;
  version: string;
};

export type ManagedProviderSetupField = {
  id: string;
  label: string;
  required: boolean;
  secret: boolean;
};

export type ManagedProviderCatalogEntry = {
  apiKeyRequired: boolean;
  id: string;
  modelCatalogMode: "fixed" | "provider_api";
  modelCount: number;
  name: string;
  setupFields: ManagedProviderSetupField[];
};

export type RemotePromptId =
  | "compaction"
  | "context-pressure"
  | "enhancement"
  | "explorer"
  | "final-response"
  | "max-steps-final"
  | "reviewer"
  | "system"
  | "title"
  | "worker";

export type RemoteConfig = {
  developer: RemoteDeveloper;
  prompts: Record<RemotePromptId, string>;
  providers: ManagedProviderCatalogEntry[];
  revision: string;
  sourceUrl: string;
  update: RemoteUpdate;
  usingCachedConfig: boolean;
};
