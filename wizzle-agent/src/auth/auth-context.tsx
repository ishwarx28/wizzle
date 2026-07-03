import {
  browserLocalPersistence,
  fetchSignInMethodsForEmail,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithCredential,
  signOut,
  updateProfile,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  type User,
} from "firebase/auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { listen } from "@tauri-apps/api/event";

import { finishGoogleDesktopSignIn, isGoogleDesktopAuthConfigured, startGoogleDesktopSignIn } from "./google-desktop-oauth";
import { requireFirebaseAuth, isFirebaseConfigured } from "../lib/firebase";
import { useWorkspaceStore } from "../store/workspace-store";
import type { AccountProfile } from "../types/workspace";

type EmailSignInResult =
  | { status: "created" }
  | { status: "signed-in" }
  | { status: "verify" };

interface AuthUser {
  avatarLabel: string;
  avatarUrl: string | null;
  email: string;
  emailVerified: boolean;
  name: string;
  uid: string;
}

interface AuthContextValue {
  errorMessage: string | null;
  clearErrorMessage: () => void;
  isConfigured: boolean;
  isGoogleConfigured: boolean;
  isLoading: boolean;
  signInOrCreateWithEmail: (email: string, password: string) => Promise<EmailSignInResult>;
  signInWithGoogle: () => Promise<"redirecting" | "signed-in">;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  user: AuthUser | null;
  getIdToken: (forceRefresh?: boolean) => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const fallbackAccount: AccountProfile = {
  email: "",
  name: "Wizzle User",
  avatarLabel: "W",
  avatarUrl: null,
  plan: "Free",
};

function getNameFromEmail(email: string) {
  return email.split("@")[0]?.trim() || "Wizzle User";
}

function getAvatarLabel(name: string, email: string) {
  const words = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
  }

  const compact = (words[0] ?? getNameFromEmail(email)).replace(/[^a-zA-Z0-9]/g, "");
  return compact.slice(0, 2).toUpperCase() || "W";
}

function buildAuthUser(user: User): AuthUser {
  const email = user.email ?? "";
  const name = user.displayName?.trim() || getNameFromEmail(email);

  return {
    uid: user.uid,
    email,
    name,
    emailVerified: user.emailVerified,
    avatarUrl: user.photoURL ?? null,
    avatarLabel: getAvatarLabel(name, email),
  };
}

function buildAccountProfile(user: AuthUser | null): AccountProfile {
  if (!user) {
    return fallbackAccount;
  }

  return {
    email: user.email,
    name: user.name,
    avatarLabel: user.avatarLabel,
    avatarUrl: user.avatarUrl,
    plan: "Free",
  };
}

function toFriendlyAuthError(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";

  switch (code) {
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/missing-password":
    case "auth/weak-password":
      return "Choose a password with at least 6 characters.";
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "The email or password is incorrect.";
    case "auth/email-already-in-use":
      return "That email is already in use. Try logging in instead.";
    case "auth/account-exists-with-different-credential":
      return "This email already uses a different sign-in method.";
    case "auth/popup-closed-by-user":
      return "Google sign-in was closed before it finished.";
    case "auth/popup-blocked":
      return "Allow the Google sign-in popup and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    default:
      return error instanceof Error ? error.message : "Something went wrong. Please try again.";
  }
}

function getFirebaseErrorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? String(error.code) : "";
}

export function AuthProvider({ children }: PropsWithChildren) {
  const setAccount = useWorkspaceStore((state) => state.setAccount);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setUser(null);
      setAccount(fallbackAccount);
      setIsLoading(false);
      return;
    }

    const auth = requireFirebaseAuth();
    let isMounted = true;
    let unsubscribeAuthState: () => void = () => {};
    let unsubscribeGoogleCallback: () => void = () => {};

    const processGoogleCallback = async (rawUrl: string) => {
      try {
        const tokens = await finishGoogleDesktopSignIn(rawUrl);

        if (!tokens || !isMounted) {
          return;
        }

        setErrorMessage(null);

        const credential = GoogleAuthProvider.credential(tokens.idToken, tokens.accessToken);
        const credentials = await signInWithCredential(auth, credential);
        const providerProfile = credentials.user.providerData.find(
          (entry) => entry.providerId === "google.com",
        );
        const name =
          credentials.user.displayName?.trim() ||
          providerProfile?.displayName?.trim() ||
          getNameFromEmail(credentials.user.email ?? "");
        const avatarUrl = credentials.user.photoURL || providerProfile?.photoURL || null;

        await updateProfile(credentials.user, {
          displayName: name,
          photoURL: avatarUrl,
        });
      } catch (error) {
        if (isMounted) {
          setErrorMessage(toFriendlyAuthError(error));
        }
      }
    };

    void (async () => {
      await setPersistence(auth, browserLocalPersistence).catch(() => undefined);

      if (!isMounted) {
        return;
      }

      unsubscribeAuthState = onAuthStateChanged(auth, (nextUser) => {
        if (!isMounted) {
          return;
        }

        const resolvedUser = nextUser ? buildAuthUser(nextUser) : null;
        setUser(resolvedUser);
        setAccount(buildAccountProfile(resolvedUser));
        setIsLoading(false);
      });

      try {
        unsubscribeGoogleCallback = await listen<{ url: string }>("google-oauth-callback", (event) => {
          void processGoogleCallback(event.payload.url);
        });
      } catch (error) {
        if (isMounted) {
          setErrorMessage(toFriendlyAuthError(error));
        }
      }
    })();

    return () => {
      isMounted = false;
      unsubscribeAuthState();
      unsubscribeGoogleCallback();
    };
  }, [setAccount]);

  const signInOrCreateWithEmail = useCallback(
    async (email: string, password: string): Promise<EmailSignInResult> => {
      const auth = requireFirebaseAuth();
      const normalizedEmail = email.trim().toLowerCase();
      const trimmedPassword = password.trim();
      setErrorMessage(null);

      if (!normalizedEmail || !trimmedPassword) {
        throw new Error("Enter both email and password.");
      }

      try {
        const displayName = getNameFromEmail(normalizedEmail);

        try {
          const credentials = await signInWithEmailAndPassword(
            auth,
            normalizedEmail,
            trimmedPassword,
          );

          if (!credentials.user.displayName?.trim()) {
            await updateProfile(credentials.user, {
              displayName,
              photoURL: null,
            });
          }

          if (!credentials.user.emailVerified) {
            return { status: "verify" };
          }

          return { status: "signed-in" };
        } catch (signInError) {
          const signInCode = getFirebaseErrorCode(signInError);

          if (signInCode !== "auth/user-not-found" && signInCode !== "auth/invalid-credential") {
            throw signInError;
          }
        }

        const methods = await fetchSignInMethodsForEmail(auth, normalizedEmail);

        if (methods.length === 0) {
          const credentials = await createUserWithEmailAndPassword(
            auth,
            normalizedEmail,
            trimmedPassword,
          );

          await updateProfile(credentials.user, {
            displayName,
            photoURL: null,
          });
          await sendEmailVerification(credentials.user);

          return { status: "created" };
        }

        if (!methods.includes("password")) {
          if (methods.includes("google.com")) {
            try {
              await sendPasswordResetEmail(auth, normalizedEmail);
            } catch (passwordSetupError) {
              if (passwordSetupError instanceof Error) {
                throw passwordSetupError;
              }
            }

            throw new Error(
              "This email was first used with Google. We sent a password setup link to your inbox and spam folder.",
            );
          }

          throw new Error("This email uses another sign-in method.");
        }

        throw new Error("The email or password is incorrect.");
      } catch (error) {
        throw new Error(toFriendlyAuthError(error));
      }
    },
    [],
  );

  const signInWithGoogle = useCallback(async (): Promise<"redirecting" | "signed-in"> => {
    setErrorMessage(null);

    try {
      await startGoogleDesktopSignIn();
      return "redirecting";
    } catch (error) {
      throw new Error(toFriendlyAuthError(error));
    }
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    const auth = requireFirebaseAuth();
    const normalizedEmail = email.trim().toLowerCase();
    setErrorMessage(null);

    if (!normalizedEmail) {
      throw new Error("Enter your email address first.");
    }

    try {
      await sendPasswordResetEmail(auth, normalizedEmail);
    } catch (error) {
      throw new Error(toFriendlyAuthError(error));
    }
  }, []);

  const signOutUser = useCallback(async () => {
    if (!isFirebaseConfigured) {
      return;
    }

    await signOut(requireFirebaseAuth());
  }, []);

  const getIdToken = useCallback(async (forceRefresh = false) => {
    const auth = requireFirebaseAuth();

    if (!auth.currentUser) {
      throw new Error("No signed-in user is available.");
    }

    return auth.currentUser.getIdToken(forceRefresh);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isConfigured: isFirebaseConfigured,
      isGoogleConfigured: isGoogleDesktopAuthConfigured(),
      errorMessage,
      clearErrorMessage: () => setErrorMessage(null),
      signInOrCreateWithEmail,
      signInWithGoogle,
      signOut: signOutUser,
      sendPasswordReset,
      getIdToken,
    }),
    [errorMessage, getIdToken, isLoading, sendPasswordReset, signInOrCreateWithEmail, signInWithGoogle, signOutUser, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return context;
}
