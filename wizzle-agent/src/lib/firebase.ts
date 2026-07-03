import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

export const isFirebaseConfigured = [
  firebaseConfig.apiKey,
  firebaseConfig.authDomain,
  firebaseConfig.projectId,
  firebaseConfig.appId,
].every((value) => Boolean(value));

const firebaseApp = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;

export function requireFirebaseAuth() {
  if (!firebaseAuth) {
    throw new Error("Firebase is not configured.");
  }

  return firebaseAuth;
}
