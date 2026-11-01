import { Hono } from "hono";

// The OAuth callback is public: its auth is the signed `state` parameter, not a session.
export const googleCalendarRoutes = new Hono();

googleCalendarRoutes.get("/callback", (c) => c.json({ state: c.req.query("state") ?? null }));

googleCalendarRoutes.post("/sync", (c) => c.json({ queued: true }));
