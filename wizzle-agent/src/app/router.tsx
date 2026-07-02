import { Navigate, createHashRouter } from "react-router-dom";

import { AppPage } from "../pages/AppPage";
import { LoginPage } from "../pages/LoginPage";
import { ResetPasswordPage } from "../pages/ResetPasswordPage";

export const appRouter = createHashRouter([
  {
    path: "/",
    element: <Navigate replace to="/login" />,
  },
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/reset-password",
    element: <ResetPasswordPage />,
  },
  {
    path: "/app",
    element: <AppPage />,
  },
  {
    path: "*",
    element: <Navigate replace to="/login" />,
  },
]);
