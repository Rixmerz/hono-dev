import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

type Variables = { env: { GREETING: string } };

export const greetingRoutes = new Hono<{ Variables: Variables }>();

greetingRoutes.get("/", (c) => c.json({ message: c.var.env.GREETING }));

greetingRoutes.post("/", zValidator("json", z.object({ name: z.string() })), (c) => {
  return c.json({ message: `${c.var.env.GREETING}, ${c.req.valid("json").name}` }, 201);
});
