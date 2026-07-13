import { createHashRouter } from "react-router-dom";

import { AppPage } from "../pages/AppPage";
import { AppErrorPage } from "../pages/AppErrorPage";

export const appRouter = createHashRouter([
  {
    path: "/",
    element: <AppPage />,
    errorElement: <AppErrorPage />,
  },
  {
    path: "*",
    element: <AppPage />,
    errorElement: <AppErrorPage />,
  },
]);
