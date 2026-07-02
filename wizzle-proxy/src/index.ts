import { serve } from "@hono/node-server";

import { env } from "./config.js";
import { app } from "./routes.js";

serve(
  {
    fetch: app.fetch,
    port: env.port
  },
  (info) => {
    console.log(`wizzle-proxy listening on http://localhost:${info.port}`);
  }
);
