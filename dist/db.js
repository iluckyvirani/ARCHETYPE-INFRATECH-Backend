import { neon } from "@neondatabase/serverless";
import "dotenv/config";
if (!process.env.DATABASE_URL) {
    console.warn("Warning: DATABASE_URL is not set. Database queries will fail until you add it to .env");
}
export const sql = neon(process.env.DATABASE_URL ?? "postgresql://placeholder");
