import { Router } from "express";
import { sql } from "../db.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      res.json({
        status: "ok",
        database: "not configured",
        message: "Set DATABASE_URL in server/.env",
      });
      return;
    }

    const result = await sql`SELECT 1 AS ok`;
    res.json({
      status: "ok",
      database: "connected",
      result: result[0],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({
      status: "error",
      database: "disconnected",
      message,
    });
  }
});

export default router;
