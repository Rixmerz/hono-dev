import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { postRoutes } from "./routes/posts.ts";
import { userRoutes } from "./routes/users.ts";

export const app = new Hono();

app.use("*", logger());

app.get("/health", (c) => c.json({ ok: true }));

app.route("/posts", postRoutes);
app.route("/users", userRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
