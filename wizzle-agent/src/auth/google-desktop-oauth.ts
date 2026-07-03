import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const HANDLED_CALLBACK_STORAGE_KEY = "wizzle.google-oauth.handled";
const handledGoogleCallbackKeys = new Set<string>();
const pendingGoogleCallbackKeys = new Set<string>();

interface NativeGoogleOAuthSession {
  codeVerifier: string;
  redirectUri: string;
  state: string;
}

interface GoogleOAuthTokens {
  accessToken: string | null;
  idToken: string | null;
}

function getGoogleClientId() {
  return import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim() || "";
}

function getGoogleClientSecret() {
  return import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_SECRET?.trim() || "";
}

export function isGoogleDesktopAuthConfigured() {
  return Boolean(getGoogleClientId() && getGoogleClientSecret());
}

function randomString(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function toBase64Url(bytes: Uint8Array) {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createPkcePair() {
  const codeVerifier = randomString(64);
  const codeChallenge = toBase64Url(await sha256(codeVerifier));

  return { codeVerifier, codeChallenge };
}

function readHandledCallbackKeys() {
  const rawValue = localStorage.getItem(HANDLED_CALLBACK_STORAGE_KEY);

  if (!rawValue) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function saveHandledCallbackKeys(keys: string[]) {
  localStorage.setItem(HANDLED_CALLBACK_STORAGE_KEY, JSON.stringify(keys.slice(-12)));
}

function getGoogleCallbackKey(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) {
      return null;
    }

    return `${state}:${code}`;
  } catch {
    return null;
  }
}

function markGoogleCallbackHandled(callbackKey: string) {
  pendingGoogleCallbackKeys.delete(callbackKey);
  handledGoogleCallbackKeys.add(callbackKey);
  saveHandledCallbackKeys([...readHandledCallbackKeys(), callbackKey]);

  if (handledGoogleCallbackKeys.size > 12) {
    const oldestKey = handledGoogleCallbackKeys.values().next().value;
    if (oldestKey) {
      handledGoogleCallbackKeys.delete(oldestKey);
    }
  }
}

async function readPendingState(): Promise<NativeGoogleOAuthSession | null> {
  const session = await invoke<{
    code_verifier: string;
    redirect_uri: string;
    state: string;
  } | null>("get_google_oauth_session");

  if (!session) {
    return null;
  }

  return {
    codeVerifier: session.code_verifier,
    redirectUri: session.redirect_uri,
    state: session.state,
  };
}

async function clearPendingState() {
  await invoke("clear_google_oauth_session");
}

function parseGoogleRedirectUrl(rawUrl: string, redirectUri: string) {
  const url = new URL(rawUrl);
  const expected = new URL(redirectUri);

  if (
    url.protocol !== expected.protocol ||
    url.hostname !== expected.hostname ||
    url.port !== expected.port ||
    url.pathname !== expected.pathname
  ) {
    return null;
  }

  return url;
}

async function exchangeCodeForTokens(code: string, codeVerifier: string, redirectUri: string) {
  const clientSecret = getGoogleClientSecret();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: getGoogleClientId(),
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as
      | {
          error?: string;
          error_description?: string;
        }
      | null;

    const details = [payload?.error, payload?.error_description]
      .filter((value): value is string => Boolean(value))
      .join(": ");

    throw new Error(
      details ? `Google sign-in could not be completed. ${details}` : "Google sign-in could not be completed.",
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    id_token?: string;
  };

  return {
    accessToken: payload.access_token ?? null,
    idToken: payload.id_token ?? null,
  };
}

export async function startGoogleDesktopSignIn() {
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();

  if (!clientId || !clientSecret) {
    throw new Error(
      "Google desktop OAuth is not configured yet. Add VITE_GOOGLE_OAUTH_CLIENT_ID and VITE_GOOGLE_OAUTH_CLIENT_SECRET to wizzle-agent/.env.",
    );
  }

  const { codeChallenge, codeVerifier } = await createPkcePair();
  const state = randomString(24);
  const redirectUri = await invoke<string>("start_google_oauth_listener", {
    session: {
      codeVerifier,
      state,
    },
  });

  const searchParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "select_account",
  });

  await openUrl(`${GOOGLE_AUTH_BASE_URL}?${searchParams.toString()}`);
}

export async function finishGoogleDesktopSignIn(rawUrl: string): Promise<GoogleOAuthTokens | null> {
  const callbackKey = getGoogleCallbackKey(rawUrl);

  if (callbackKey) {
    const persistedHandledKeys = readHandledCallbackKeys();

    if (pendingGoogleCallbackKeys.has(callbackKey) || handledGoogleCallbackKeys.has(callbackKey) || persistedHandledKeys.includes(callbackKey)) {
      handledGoogleCallbackKeys.add(callbackKey);
      return null;
    }
  }

  const pendingState = await readPendingState();
  if (!pendingState) {
    throw new Error("Google sign-in session expired. Try again.");
  }

  const url = parseGoogleRedirectUrl(rawUrl, pendingState.redirectUri);

  if (!url) {
    return null;
  }

  const error = url.searchParams.get("error");
  if (error) {
    await clearPendingState();
    throw new Error(error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed.");
  }

  const returnedState = url.searchParams.get("state");
  if (!returnedState || returnedState !== pendingState.state) {
    await clearPendingState();
    throw new Error("Google sign-in state mismatch. Try again.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    await clearPendingState();
    throw new Error("Google sign-in did not return an authorization code.");
  }

  if (callbackKey) {
    pendingGoogleCallbackKeys.add(callbackKey);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, pendingState.codeVerifier, pendingState.redirectUri);
    await clearPendingState();

    if (callbackKey) {
      markGoogleCallbackHandled(callbackKey);
    }

    return tokens;
  } catch (error) {
    if (callbackKey) {
      pendingGoogleCallbackKeys.delete(callbackKey);
    }

    throw error;
  }
}
