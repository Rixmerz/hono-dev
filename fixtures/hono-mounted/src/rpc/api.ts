import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

// Chained registration keeps the route types, so hc<AppType> can see them.
export const rpcApp = new Hono()
  .get("/hello", zValidator("query", z.object({ name: z.string() })), (c) => {
    return c.json({ message: `hello ${c.req.valid("query").name}` });
  })
  .post("/echo", zValidator("json", z.object({ text: z.string() })), (c) => {
    return c.json(c.req.valid("json"));
  });

export type AppType = typeof rpcApp;
