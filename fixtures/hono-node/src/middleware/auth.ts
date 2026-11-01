import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { loadEnv } from "../env.ts";

export const requireAuth = createMiddleware(async (c, next) => {
  const header = c.req.header("authorization");
  if (header !== `Bearer ${loadEnv().API_TOKEN}`) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
});
