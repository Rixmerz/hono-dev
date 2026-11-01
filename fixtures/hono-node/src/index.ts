import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { loadEnv } from "./env.ts";

serve({ fetch: app.fetch, port: loadEnv().PORT });
