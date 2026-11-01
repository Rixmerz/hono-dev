import { createMiddleware } from "hono/factory";

export const tenantMiddleware = createMiddleware(async (c, next) => {
  c.header("x-tenant", c.req.header("x-tenant-id") ?? "default");
  await next();
});
