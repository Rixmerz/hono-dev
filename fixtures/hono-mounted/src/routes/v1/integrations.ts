import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth.ts";
import { tenantMiddleware } from "../../middleware/tenant.ts";

export const integrationRoutes = new Hono();

integrationRoutes.use("*", authMiddleware, tenantMiddleware);

integrationRoutes.get("/", (c) => c.json({ providers: ["google-calendar"] }));

integrationRoutes.get("/:provider", (c) => c.json({ provider: c.req.param("provider") }));
