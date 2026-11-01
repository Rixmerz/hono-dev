import { z } from "zod";

const envSchema = z.object({ PORT: z.coerce.number().default(8000) });

export function loadEnv(): z.infer<typeof envSchema> {
  return envSchema.parse(Deno.env.toObject());
}
