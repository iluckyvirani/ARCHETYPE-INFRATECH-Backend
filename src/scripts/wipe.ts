import "dotenv/config";
import { sql } from "../db.js";

async function wipe() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  await sql`DELETE FROM notifications`;
  await sql`DELETE FROM schedule_items`;
  await sql`DELETE FROM clients`;

  const counts = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM clients) AS clients,
      (SELECT COUNT(*)::int FROM schedule_items) AS schedule_items,
      (SELECT COUNT(*)::int FROM notifications) AS notifications
  `;

  const row = counts[0] as {
    clients: number;
    schedule_items: number;
    notifications: number;
  };

  console.log("Neon database wiped.");
  console.log(
    `Remaining rows — clients: ${row.clients}, schedule_items: ${row.schedule_items}, notifications: ${row.notifications}`
  );
}

wipe()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Wipe failed:", err);
    process.exit(1);
  });
