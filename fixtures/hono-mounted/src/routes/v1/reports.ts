import { Hono } from "hono";

const reports = new Hono();

// A sub-app error handler wraps the handlers copied out of it when it is mounted.
reports.onError((_err, c) => c.json({ error: "report failed" }, 500));

reports.get("/summary", (c) => c.json({ total: 1 }));

export default reports;
