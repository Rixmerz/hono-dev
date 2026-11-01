// Reads the signing secret straight from the environment: S003.
export const signingSecret = process.env.JWT_SECRET;

export const requireAuth = async (c: { req: { header(n: string): string | undefined } }, next: () => Promise<void>) => {
  if (!c.req.header("authorization")) throw new Error("unauthorized");
  await next();
};
