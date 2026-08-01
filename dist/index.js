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
const defaultOrigins = [
    "http://localhost:5173",
    "https://archetype-infratech-frotend.vercel.app",
];
const allowedOrigins = [
    ...new Set([
        ...defaultOrigins,
        ...(process.env.CLIENT_ORIGIN || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    ]),
];
app.use(cors({
    origin(origin, callback) {
        if (!origin ||
            allowedOrigins.includes(origin) ||
            allowedOrigins.includes("*")) {
            callback(null, true);
            return;
        }
        callback(new Error(`CORS blocked: ${origin}`));
    },
}));
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
    }
    catch (err) {
        console.error("Migration failed:", err);
    }
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
if (process.env.VERCEL) {
    migrate().catch((err) => console.error("Migration failed:", err));
}
else {
    start();
}
export default app;
