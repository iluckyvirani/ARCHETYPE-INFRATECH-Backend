import express from "express";
import cors from "cors";
import "dotenv/config";
import { migrate } from "./db/migrate.js";
import healthRouter from "./routes/health.js";
import clientsRouter from "./routes/clients.js";
import notificationsRouter from "./routes/notifications.js";
import migrateRouter from "./routes/migrate.js";

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(
  cors({
    origin: "http://localhost:5173",
  })
);
app.use(express.json());

app.use("/api/health", healthRouter);
app.use("/api/migrate", migrateRouter);
app.use("/api/clients", clientsRouter);
app.use("/api/notifications", notificationsRouter);

app.get("/", (_req, res) => {
  res.json({ name: "Artech Bill API", version: "1.0.0" });
});

async function start() {
  try {
    await migrate();
    console.log("Database schema ready");
  } catch (err) {
    console.error("Migration failed:", err);
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();
