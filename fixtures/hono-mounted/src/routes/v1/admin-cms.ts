import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const moduleSchema = z.object({ slug: z.string() });

export const adminCmsRoutes = new Hono();

adminCmsRoutes.get("/modules", (c) => c.json([]));

adminCmsRoutes.post("/modules", zValidator("json", moduleSchema), (c) => {
  return c.json(c.req.valid("json"), 201);
});
