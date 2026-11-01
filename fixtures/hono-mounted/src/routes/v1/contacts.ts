import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware, requireRole } from "../../middleware/auth.ts";
import { tenantMiddleware } from "../../middleware/tenant.ts";
import {
  createContact,
  getContact,
  importContacts,
  listContacts,
} from "../../services/contact.service.ts";

const createSchema = z.object({ name: z.string().min(1) });
const importSchema = z.object({ names: z.array(z.string()) });

export const contactRoutes = new Hono();

contactRoutes.use("*", authMiddleware, tenantMiddleware);

contactRoutes.get("/", (c) => c.json(listContacts()));

contactRoutes.get("/export", requireRole("admin"), (c) => c.json(listContacts()));

contactRoutes.get("/:id", (c) => {
  const contact = getContact(c.req.param("id"));
  return contact ? c.json(contact) : c.json({ error: "Not found" }, 404);
});

contactRoutes.post("/", zValidator("json", createSchema), (c) => {
  const body = c.req.valid("json");
  return c.json(createContact(body.name), 201);
});

contactRoutes.post("/import", zValidator("json", importSchema), (c) => {
  const body = c.req.valid("json");
  return c.json({ imported: importContacts(body.names) });
});

contactRoutes.delete("/:id", (c) => c.body(null, 204));
