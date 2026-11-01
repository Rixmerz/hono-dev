import express from "express";

// Negative control: `app.get`, `app.use` and `app.listen` exist here, but this is Express.
const app = express();

app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/items", (req, res) => res.status(201).json(req.body));

app.listen(3000);
