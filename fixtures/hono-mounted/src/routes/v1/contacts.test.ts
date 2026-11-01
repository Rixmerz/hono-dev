import { app } from "../../app.ts";

// Never executed: a test file that references the contact paths.
export async function listContactsTest(): Promise<void> {
  const res = await app.request("/v1/contacts/1");
  if (res.status !== 401) throw new Error("expected 401");
}
