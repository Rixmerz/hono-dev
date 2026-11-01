import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const signupSchema = z.object({ email: z.string().email() });

export const userRoutes = new Hono();

userRoutes.get("/:id", (c) => c.json({ id: c.req.param("id") }));

userRoutes.post("/", zValidator("json", signupSchema), (c) => {
  return c.json({ email: c.req.valid("json").email }, 201);
});
