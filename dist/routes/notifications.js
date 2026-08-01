import { Router } from "express";
import { sql } from "../db.js";
import { toDateOnly, todayISO } from "../lib/billing.js";
const router = Router();
/** Unpaid EMI / advance / balance rows whose due date is today or earlier. */
router.get("/", async (_req, res) => {
    try {
        const today = todayISO();
        const rows = await sql `
      SELECT
        s.id AS schedule_item_id,
        s.client_id,
        s.invoice_id,
        s.kind AS schedule_kind,
        s.label AS schedule_label,
        s.amount AS schedule_amount,
        s.due_date,
        s.paid AS schedule_paid,
        s.created_at,
        c.name AS client_name,
        c.group_id,
        n.id AS notification_id,
        n.read AS notification_read
      FROM schedule_items s
      INNER JOIN clients c ON c.id = COALESCE(s.invoice_id, s.client_id)
      LEFT JOIN notifications n ON n.schedule_item_id = s.id
      WHERE s.paid = FALSE
        AND s.due_date <= ${today}
        AND s.kind IN ('installment', 'one_time', 'stage', 'advance')
        AND COALESCE(c.completed, FALSE) = FALSE
      ORDER BY s.due_date ASC, s.created_at ASC
    `;
        res.json(rows.map((r) => {
            const dueDate = toDateOnly(r.due_date) || today;
            const kind = String(r.schedule_kind);
            const amount = Number(r.schedule_amount);
            const label = String(r.schedule_label);
            const name = String(r.client_name || "Client");
            const invoiceId = String(r.invoice_id || r.client_id);
            const groupId = r.group_id ? String(r.group_id) : invoiceId;
            const overdue = dueDate < today;
            return {
                id: r.notification_id ? String(r.notification_id) : String(r.schedule_item_id),
                clientId: groupId,
                scheduleItemId: String(r.schedule_item_id),
                title: kind === "advance"
                    ? overdue
                        ? "Advance overdue"
                        : "Advance payment due"
                    : overdue
                        ? "EMI overdue"
                        : "EMI due today",
                message: `${name} — ${label} · ₹${amount.toLocaleString("en-IN")}`,
                dueDate,
                read: Boolean(r.notification_read),
                createdAt: String(r.created_at),
                clientName: name,
                scheduleKind: kind,
                schedulePaid: false,
                amount,
                scheduleLabel: label,
                invoiceId,
            };
        }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Failed";
        res.status(500).json({ error: message });
    }
});
router.patch("/:id/read", async (req, res) => {
    try {
        await sql `UPDATE notifications SET read = TRUE WHERE id = ${req.params.id}`;
        await sql `
      UPDATE notifications SET read = TRUE
      WHERE schedule_item_id = ${req.params.id}
    `;
        res.json({ ok: true });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Failed";
        res.status(500).json({ error: message });
    }
});
export default router;
