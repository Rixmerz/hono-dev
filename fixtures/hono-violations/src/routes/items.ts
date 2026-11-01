import { Hono } from "hono";
import { db } from "../db.ts";

export const items = new Hono();

// R002: the param route is registered before the static one it shadows.
items.get("/:id", (c) => c.json({ id: c.req.param("id") }));
items.get("/new", (c) => c.json({ fresh: true }));

// V001: reads the body, no validator.
items.post("/", async (c) => c.json(await c.req.json(), 201));

// V003: asks for validated query data that nothing validates.
items.get("/search", (c) => c.json(c.req.valid("query")));

// A001: the handler talks to the database itself.
items.get("/all", async (c) => c.json(await db.item.findMany()));

// R001: the same route twice, the second never runs.
items.get("/dup", (c) => c.text("first"));
items.get("/dup", (c) => c.text("second"));
