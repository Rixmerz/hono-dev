import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  API_TOKEN: z.string().default("dev-token"),
});

export type Env = z.infer<typeof envSchema>;

// Parsed lazily so importing the app never needs a configured environment.
export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
