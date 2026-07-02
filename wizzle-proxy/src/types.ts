export type AppBindings = {
  Variables: {
    requestId: string;
    uid?: string;
    projectId?: string;
    chatId?: string;
    model?: string;
    reasoningLevel?: ReasoningLevel;
    upstreamError?: string;
  };
};

export type AppConfig = {
  defaultModel: string;
  models: Record<string, WizzleModelConfig>;
};

export type ReasoningLevel = "balanced" | "max";

export type WizzleModelConfig = {
  id: string;
  upstream: {
    path: "/v1/chat/completions";
    model: string;
  };
  reasoningMap: Record<ReasoningLevel, "medium" | "max">;
};

export type DecodedToken = {
  uid: string;
};

export type AuthVerifier = (token: string) => Promise<DecodedToken>;

export type LogEntry = {
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  uid?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  upstreamError?: string;
};

export type Logger = (entry: LogEntry) => void;
