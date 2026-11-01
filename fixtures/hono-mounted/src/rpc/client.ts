import { hc } from "hono/client";
import type { AppType } from "./api.ts";

export const client = hc<AppType>("http://localhost:3000/rpc");
