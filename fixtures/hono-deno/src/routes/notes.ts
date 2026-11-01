import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const noteSchema = z.object({ text: z.string().min(1) });

const notes: { id: number; text: string }[] = [];

export const noteRoutes = new Hono();

noteRoutes.get("/", (c) => c.json(notes));

noteRoutes.get("/:id", (c) => {
  const note = notes.find((n) => n.id === Number(c.req.param("id")));
  return note ? c.json(note) : c.json({ error: "Not found" }, 404);
});

noteRoutes.post("/", zValidator("json", noteSchema), (c) => {
  const note = { id: notes.length + 1, text: c.req.valid("json").text };
  notes.push(note);
  return c.json(note, 201);
});
