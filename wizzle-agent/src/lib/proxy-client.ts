import { requireFirebaseAuth } from "./firebase";

function getProxyBaseUrl() {
  return import.meta.env.VITE_WIZZLE_PROXY_BASE_URL?.trim() || "http://localhost:8787";
}

export async function getProxyAuthorizationHeaders(headers?: HeadersInit) {
  const auth = requireFirebaseAuth();

  if (!auth.currentUser) {
    throw new Error("Sign in before calling the proxy.");
  }

  const idToken = await auth.currentUser.getIdToken();
  const nextHeaders = new Headers(headers);
  nextHeaders.set("Authorization", `Bearer ${idToken}`);

  return nextHeaders;
}

export async function proxyFetch(path: string, init: RequestInit = {}) {
  const headers = await getProxyAuthorizationHeaders(init.headers);

  return fetch(`${getProxyBaseUrl()}${path}`, {
    ...init,
    headers,
  });
}
