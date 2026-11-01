import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.ts";
import { getPost, listPosts, removePost, savePost } from "../services/post.service.ts";

const postSchema = z.object({ id: z.string(), title: z.string().min(1) });

export const postRoutes = new Hono();

postRoutes.use("*", requireAuth);

postRoutes.get("/", (c) => c.json(listPosts()));

postRoutes.get("/:id", (c) => {
  const post = getPost(c.req.param("id"));
  return post ? c.json(post) : c.json({ error: "Not found" }, 404);
});

postRoutes.post("/", zValidator("json", postSchema), (c) => {
  return c.json(savePost(c.req.valid("json")), 201);
});

postRoutes.put("/:id", zValidator("json", postSchema), (c) => {
  return c.json(savePost(c.req.valid("json")));
});

postRoutes.delete("/:id", (c) => {
  return removePost(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
});
