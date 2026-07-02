import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cert, getApps, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { z } from "zod";

import { env } from "../config.js";
import { HttpError } from "../errors.js";
import type { AuthVerifier } from "../types.js";

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().min(1)
});

function readServiceAccount() {
  const filePath = resolve(process.cwd(), env.firebaseServiceAccountPath);

  try {
    const raw = serviceAccountSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));

    return {
      projectId: raw.project_id,
      serviceAccount: {
        projectId: raw.project_id,
        clientEmail: raw.client_email,
        privateKey: raw.private_key
      } satisfies ServiceAccount
    };
  } catch {
    throw new Error(`Invalid Firebase service account file: ${filePath}`);
  }
}

function getFirebaseApp() {
  const { projectId, serviceAccount } = readServiceAccount();

  return getApps()[0] ??
    initializeApp({
      credential: cert(serviceAccount),
      projectId
    });
}

export const verifyIdToken: AuthVerifier = async (token) => {
  try {
    return await getAuth(getFirebaseApp()).verifyIdToken(token);
  } catch {
    throw new HttpError(401, "invalid_auth", "Authentication failed");
  }
};
