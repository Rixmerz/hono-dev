import { app } from "./app.ts";

// Never executed: references the paths of the post and user routes.
export async function smoke(): Promise<void> {
  await app.request("/posts/1", { headers: { authorization: "Bearer dev-token" } });
  await app.request("/users/1");
}
