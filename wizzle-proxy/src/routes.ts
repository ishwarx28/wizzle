import { createApp } from "./app.js";
import { appConfig, env } from "./config.js";
import { verifyIdToken } from "./services/firebase-auth.js";
import { createUpstreamCaller } from "./services/upstream.js";

function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify(entry));
}

export const app = createApp({
  config: appConfig,
  verifyIdToken,
  callUpstream: createUpstreamCaller({
    baseUrl: env.upstreamBaseUrl,
    apiKey: env.upstreamApiKey
  }),
  logger: (entry) => {
    log({
      event: "request",
      requestId: entry.requestId,
      method: entry.method,
      path: entry.path,
      status: entry.status,
      latencyMs: entry.latencyMs,
      uid: entry.uid,
      model: entry.model,
      reasoningLevel: entry.reasoningLevel,
      upstreamError: entry.upstreamError
    });
  }
});
