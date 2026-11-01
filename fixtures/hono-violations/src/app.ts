import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireAuth } from "./auth.ts";
import { items } from "./routes/items.ts";

export const app = new Hono();

// S001: a wildcard origin together with credentials.
app.use("*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.text("ok"));
app.route("/items", items);

// R003: added to the sub-app after route() copied its table.
items.get("/late", (c) => c.text("never served"));

// M002: registered after the route() mount it should cover.
app.use("/items/*", requireAuth);

// M004: takes next and never calls it.
app.use("/audit/*", async (c, next) => {
  c.header("x-audited", "1");
});

// C003: deprecated since Hono 4.13.
app.mount("/legacy", (req: Request) => new Response(req.url));

// No onError and no notFound on the served root: A002, A003.
