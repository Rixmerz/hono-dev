import { z } from "zod";

export const envSchema = z.object({
  GREETING: z.string().default("hello"),
  API_TOKEN: z.string().min(1),
});

export type Bindings = z.infer<typeof envSchema>;
