import { RouterProvider } from "react-router-dom";

import { appRouter } from "./app/router";
import { AuthProvider } from "./auth/auth-context";

function App() {
  return (
    <AuthProvider>
      <RouterProvider router={appRouter} />
    </AuthProvider>
  );
}

export default App;
