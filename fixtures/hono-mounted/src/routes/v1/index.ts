import { Hono } from "hono";
import {
  adminRoutes,
  contactRoutes,
  googleCalendarRoutes,
  integrationRoutes,
  reportRoutes,
} from "../barrel.ts";

export const v1 = new Hono();

v1.route("/contacts", contactRoutes);
// Mounted BEFORE the broader /integrations prefix on purpose: integrationRoutes.use("*", auth)
// is copied after these routes, so the public OAuth callback never reaches it (hono-base.js:106-118).
v1.route("/integrations/google-calendar", googleCalendarRoutes);
v1.route("/integrations", integrationRoutes);
v1.route("/admin", adminRoutes);
v1.route("/reports", reportRoutes);
