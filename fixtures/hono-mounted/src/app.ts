import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { rpcApp } from "./rpc/api.ts";
import { v1 } from "./routes/v1/index.ts";

export const app = new Hono();

app.use("*", logger());
app.use("*", cors({ origin: ["https://app.example.com"], credentials: true }));
app.use("/v1/*", secureHeaders());

// a basePath instance shares the table of `app`: its routes are served directly
const api = app.basePath("/api");
api.get("/ping", (c) => c.text("pong"));

app.route("/v1", v1);
app.route("/rpc", rpcApp);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
