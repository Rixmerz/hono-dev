import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

export const authMiddleware = createMiddleware(async (c, next) => {
  const token = c.req.header("authorization");
  if (!token) throw new HTTPException(401, { message: "Missing token" });
  await next();
});

export function requireRole(role: string) {
  return createMiddleware(async (c, next) => {
    if (c.req.header("x-role") !== role) throw new HTTPException(403, { message: "Forbidden" });
    await next();
  });
}
