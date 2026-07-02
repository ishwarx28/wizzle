import { config as loadEnv } from "dotenv";
import { z } from "zod";

import { createAppConfig } from "./model-registry.js";

loadEnv();

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().min(1).default("credentials/firebase-service-account.json"),
    UPSTREAM_BASE_URL: z.url(),
    UPSTREAM_API_KEY: z.string().default(""),
    WIZZLE_1_THINKING_UPSTREAM_MODEL: z.string().min(1).default("deepseek-v4-flash-free")
  })
  .transform((env) => ({
    port: env.PORT,
    firebaseServiceAccountPath: env.FIREBASE_SERVICE_ACCOUNT_PATH,
    upstreamBaseUrl: env.UPSTREAM_BASE_URL.replace(/\/+$/, ""),
    upstreamApiKey: env.UPSTREAM_API_KEY,
    wizzle1ThinkingUpstreamModel: env.WIZZLE_1_THINKING_UPSTREAM_MODEL
  }));

export const env = envSchema.parse(process.env);

export const appConfig = createAppConfig({
  wizzle1ThinkingUpstreamModel: env.wizzle1ThinkingUpstreamModel
});
