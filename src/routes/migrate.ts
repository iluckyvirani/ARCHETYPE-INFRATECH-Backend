import { Router } from "express";
import { migrate } from "../db/migrate.js";

const router = Router();

router.post("/", async (_req, res) => {
  try {
    await migrate();
    res.json({ ok: true, message: "Schema migrated" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Migrate failed";
    res.status(500).json({ error: message });
  }
});

export default router;
