import { app } from "./src/app.ts";
import { loadEnv } from "./src/env.ts";

Deno.serve({ port: loadEnv().PORT }, app.fetch);
