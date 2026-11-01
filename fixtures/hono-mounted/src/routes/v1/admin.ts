import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth.ts";
import { adminCmsRoutes } from "./admin-cms.ts";

export const adminRoutes = new Hono();

adminRoutes.use("*", authMiddleware);

adminRoutes.get("/stats", (c) => c.json({ contacts: 1 }));

// two-level mount: /v1/admin + /cms
adminRoutes.route("/cms", adminCmsRoutes);
