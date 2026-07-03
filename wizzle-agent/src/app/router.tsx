import type { ReactNode } from "react";
import { Navigate, createHashRouter } from "react-router-dom";

import { useAuth } from "../auth/auth-context";
import { AppPage } from "../pages/AppPage";
import { LoginPage } from "../pages/LoginPage";
import { ResetPasswordPage } from "../pages/ResetPasswordPage";

function AuthLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="text-[14px] text-[var(--color-text-secondary)]">Loading Wizzle...</div>
    </div>
  );
}

function PublicOnlyRoute({ children }: { children: ReactNode }) {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  return user ? <Navigate replace to="/app" /> : <>{children}</>;
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  return user ? <>{children}</> : <Navigate replace to="/login" />;
}

export const appRouter = createHashRouter([
  {
    path: "/",
    element: <Navigate replace to="/login" />,
  },
  {
    path: "/login",
    element: (
      <PublicOnlyRoute>
        <LoginPage />
      </PublicOnlyRoute>
    ),
  },
  {
    path: "/reset-password",
    element: (
      <PublicOnlyRoute>
        <ResetPasswordPage />
      </PublicOnlyRoute>
    ),
  },
  {
    path: "/app",
    element: (
      <ProtectedRoute>
        <AppPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "*",
    element: <Navigate replace to="/login" />,
  },
]);
