import { createHashRouter } from "react-router-dom";

import { AppPage } from "../pages/AppPage";

export const appRouter = createHashRouter([
  {
    path: "/",
    element: <AppPage />,
  },
  {
    path: "*",
    element: <AppPage />,
  },
]);
