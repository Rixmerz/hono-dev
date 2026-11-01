import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { noteRoutes } from "./routes/notes.ts";

export const app = new Hono();

app.use("*", cors({ origin: ["https://notes.example.com"] }));

app.route("/notes", noteRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
