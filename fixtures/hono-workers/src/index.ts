import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { envSchema } from "./env.ts";
import { greetingRoutes } from "./routes/greetings.ts";

const app = new Hono();

// Bindings are validated once per request, then read from the parsed object.
app.use("*", async (c, next) => {
  c.set("env", envSchema.parse(c.env));
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

app.route("/greetings", greetingRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
