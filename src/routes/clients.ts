import { Router } from "express";
import { randomUUID } from "crypto";
import { sql } from "../db.js";
import {
  buildSchedule,
  calcTotals,
  mapClientRow,
  mapScheduleRow,
  todayISO,
  type ClientPayload,
} from "../lib/billing.js";

const router = Router();

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

async function nextInvoiceNo(): Promise<string> {
  const rows = await sql`
    SELECT invoice_no FROM clients
    ORDER BY created_at DESC
    LIMIT 100
  `;
  let max = 0;
  for (const row of rows) {
    const n = parseInt(String(row.invoice_no).replace(/\D/g, ""), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return String(max + 1).padStart(3, "0");
}

async function insertInvoice(opts: {
  groupId: string;
  body: ClientPayload;
  name: string;
}) {
  const { groupId, body, name } = opts;
  const totals = calcTotals(body);
  const invoiceId = id("inv");
  const invoiceNo = await nextInvoiceNo();
  const advance = Number(body.advanceAmount) || 0;
  const plan = totals.balance <= 0 ? "none" : body.paymentPlan || "none";

  await sql`
    INSERT INTO clients (
      id, group_id, invoice_no, name, location, project_name, fee_mode,
      area_sqft, cost_per_sqft, fee_percent, project_cost, fee_amount,
      fixed_amount, additional_works, total_bill, advance_amount, advance_date, balance,
      payment_plan, installment_mode, installment_months, installment_count,
      one_time_due_date
    ) VALUES (
      ${invoiceId},
      ${groupId},
      ${invoiceNo},
      ${name.trim()},
      ${body.location.trim()},
      ${body.projectName.trim()},
      ${body.feeMode},
      ${body.areaSqft ?? null},
      ${body.costPerSqft ?? null},
      ${body.feePercent ?? null},
      ${totals.projectCost},
      ${totals.feeAmount},
      ${body.fixedAmount ?? null},
      ${JSON.stringify(
        (body.additionalWorks || []).filter(
          (w) => w.name?.trim() && (Number(w.qty) > 0 || Number(w.rate) > 0)
        )
      )},
      ${totals.totalBill},
      ${advance},
      ${advance > 0 ? body.advanceDate || null : null},
      ${totals.balance},
      ${plan},
      ${plan === "installment" ? body.installmentMode || null : null},
      ${plan === "installment" ? body.installmentMonths || null : null},
      ${plan === "installment" ? body.installmentCount || null : null},
      ${plan === "one_time" ? body.oneTimeDueDate || null : null}
    )
  `;

  const scheduleRows = buildSchedule({
    clientId: groupId,
    balance: totals.balance,
    advanceAmount: advance,
    advanceDate: advance > 0 ? body.advanceDate : null,
    paymentPlan: plan,
    installmentMode: body.installmentMode,
    installmentMonths: body.installmentMonths,
    installmentCount: body.installmentCount,
    installmentDueDates: body.installmentDueDates,
    oneTimeDueDate: body.oneTimeDueDate,
    stages: body.stages,
  });

  const today = todayISO();
  for (const row of scheduleRows) {
    const schId = id("sch");
    const isAdvance = row.kind === "advance";
    const advanceAlreadyDue = isAdvance && row.dueDate <= today;
    const paid = advanceAlreadyDue;
    const paidAt = advanceAlreadyDue ? row.dueDate : null;
    // client_id must reference clients.id (invoice id) — groupId is not a clients row
    await sql`
      INSERT INTO schedule_items (
        id, client_id, invoice_id, kind, label, amount, due_date, paid, paid_at
      ) VALUES (
        ${schId},
        ${invoiceId},
        ${invoiceId},
        ${row.kind},
        ${row.label},
        ${row.amount},
        ${row.dueDate},
        ${paid},
        ${paidAt}
      )
    `;

    // Skip alert for advance already collected today/past
    if (isAdvance && paid) continue;

    const overdue = row.dueDate < today;
    const dueToday = row.dueDate === today;
    let title = "Upcoming payment";
    if (overdue || dueToday) {
      title = isAdvance ? "Advance payment due" : "Payment due";
    } else if (isAdvance) {
      title = "Upcoming advance";
    }
    await sql`
      INSERT INTO notifications (
        id, client_id, schedule_item_id, title, message, due_date, read
      ) VALUES (
        ${id("ntf")},
        ${invoiceId},
        ${schId},
        ${title},
        ${`${name.trim()} — ${row.label} ₹${row.amount.toLocaleString("en-IN")} due ${row.dueDate}`},
        ${row.dueDate},
        ${false}
      )
    `;
  }

  const created = await sql`SELECT * FROM clients WHERE id = ${invoiceId}`;
  return mapClientRow(created[0] as Record<string, unknown>);
}

router.get("/", async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM clients ORDER BY created_at DESC`;
    res.json(rows.map((r) => mapClientRow(r as Record<string, unknown>)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

router.get("/group/:groupId", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const invoices = await sql`
      SELECT * FROM clients
      WHERE group_id = ${groupId} OR id = ${groupId}
      ORDER BY created_at DESC
    `;
    if (!invoices[0]) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const mapped = invoices.map((r) =>
      mapClientRow(r as Record<string, unknown>)
    );
    const schedule = await sql`
      SELECT * FROM schedule_items
      WHERE client_id = ${groupId}
      ORDER BY due_date ASC, created_at ASC
    `;
    // include legacy rows tied to invoice ids
    const extra: Record<string, unknown>[] = [];
    for (const inv of mapped) {
      const rows = await sql`
        SELECT * FROM schedule_items
        WHERE invoice_id = ${inv.id} OR client_id = ${inv.id}
      `;
      extra.push(...(rows as Record<string, unknown>[]));
    }
    const seen = new Set<string>();
    const merged = [...schedule, ...extra].filter((r) => {
      const sid = String((r as { id: string }).id);
      if (seen.has(sid)) return false;
      seen.add(sid);
      return true;
    });

    // Repair: invoices with balance but missing EMI rows (failed FK inserts)
    const today = todayISO();
    for (const inv of mapped) {
      const hasEmi = merged.some((r) => {
        const kind = String((r as { kind: string }).kind);
        const iid = String(
          (r as { invoice_id?: string }).invoice_id ||
            (r as { client_id?: string }).client_id ||
            ""
        );
        return (
          iid === inv.id &&
          (kind === "installment" || kind === "one_time" || kind === "stage")
        );
      });
      if (hasEmi || inv.balance <= 0) continue;

      const plan =
        inv.paymentPlan && inv.paymentPlan !== "none"
          ? inv.paymentPlan
          : "one_time";
      const rows = buildSchedule({
        clientId: inv.id,
        balance: inv.balance,
        advanceAmount: inv.advanceAmount,
        advanceDate: inv.advanceDate,
        paymentPlan: plan,
        installmentMode: inv.installmentMode,
        installmentMonths: inv.installmentMonths,
        installmentCount: inv.installmentCount,
        oneTimeDueDate: inv.oneTimeDueDate,
      });

      for (const row of rows) {
        // Skip duplicate advance if already present
        if (row.kind === "advance") {
          const exists = merged.some(
            (r) =>
              String((r as { kind: string }).kind) === "advance" &&
              String(
                (r as { invoice_id?: string }).invoice_id ||
                  (r as { client_id?: string }).client_id ||
                  ""
              ) === inv.id
          );
          if (exists) continue;
        }
        const schId = id("sch");
        const isAdvance = row.kind === "advance";
        const paid = isAdvance && row.dueDate <= today;
        const paidAt = paid ? row.dueDate : null;
        await sql`
          INSERT INTO schedule_items (
            id, client_id, invoice_id, kind, label, amount, due_date, paid, paid_at
          ) VALUES (
            ${schId},
            ${inv.id},
            ${inv.id},
            ${row.kind},
            ${row.label},
            ${row.amount},
            ${row.dueDate},
            ${paid},
            ${paidAt}
          )
        `;
        const inserted = await sql`SELECT * FROM schedule_items WHERE id = ${schId}`;
        if (inserted[0]) {
          merged.push(inserted[0] as Record<string, unknown>);
          seen.add(schId);
        }
      }
    }

    merged.sort((a, b) =>
      String((a as { due_date: string }).due_date).localeCompare(
        String((b as { due_date: string }).due_date)
      )
    );
    const oldest = mapped[mapped.length - 1];
    res.json({
      groupId: mapped[0].groupId || groupId,
      name: mapped[0].name,
      location: mapped[0].location,
      createdAt: oldest.createdAt,
      invoices: mapped,
      schedule: merged.map((r) => mapScheduleRow(r as Record<string, unknown>)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

router.post("/group/:groupId/invoices", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const existing = await sql`
      SELECT * FROM clients
      WHERE group_id = ${groupId} OR id = ${groupId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!existing[0]) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const name = String(existing[0].name);
    const resolvedGroup =
      (existing[0].group_id as string) || String(existing[0].id);
    const body = req.body as ClientPayload;
    if (!body?.location?.trim() || !body?.projectName?.trim()) {
      res.status(400).json({ error: "location, projectName required" });
      return;
    }
    const invoice = await insertInvoice({
      groupId: resolvedGroup,
      body: { ...body, name },
      name,
    });
    res.status(201).json(invoice);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

router.patch("/group/:groupId", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const name = String(req.body?.name || "").trim();
    const location = String(req.body?.location || "").trim();
    if (!name || !location) {
      res.status(400).json({ error: "name and location required" });
      return;
    }
    await sql`
      UPDATE clients
      SET name = ${name}, location = ${location}
      WHERE group_id = ${groupId} OR id = ${groupId}
    `;
    res.json({ ok: true, name, location });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

router.delete("/group/:groupId", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const invoices = await sql`
      SELECT id FROM clients
      WHERE group_id = ${groupId} OR id = ${groupId}
    `;
    const ids = invoices.map((r) => String(r.id));
    for (const invId of ids) {
      await sql`DELETE FROM notifications WHERE client_id = ${groupId} OR client_id = ${invId}`;
      await sql`DELETE FROM schedule_items WHERE client_id = ${groupId} OR client_id = ${invId} OR invoice_id = ${invId}`;
    }
    await sql`
      DELETE FROM clients
      WHERE group_id = ${groupId} OR id = ${groupId}
    `;
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const clients = await sql`SELECT * FROM clients WHERE id = ${req.params.id}`;
    if (!clients[0]) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const mapped = mapClientRow(clients[0] as Record<string, unknown>);
    const schedule = await sql`
      SELECT * FROM schedule_items
      WHERE invoice_id = ${req.params.id}
         OR client_id = ${req.params.id}
      ORDER BY due_date ASC, created_at ASC
    `;
    res.json({
      client: mapped,
      schedule: schedule.map((r) =>
        mapScheduleRow(r as Record<string, unknown>)
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

router.post("/", async (req, res) => {
  try {
    const body = req.body as ClientPayload;
    if (
      !body?.name?.trim() ||
      !body?.location?.trim() ||
      !body?.projectName?.trim()
    ) {
      res.status(400).json({ error: "name, location, projectName required" });
      return;
    }
    const groupId = id("grp");
    const invoice = await insertInvoice({
      groupId,
      body,
      name: body.name,
    });
    res.status(201).json(invoice);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

router.patch("/:id/schedule/:scheduleId", async (req, res) => {
  try {
    const paid = Boolean(req.body?.paid);
    const bodyPaidAt =
      typeof req.body?.paidAt === "string" ? req.body.paidAt.slice(0, 10) : null;
    const paidAt = paid ? bodyPaidAt || todayISO() : null;
    const scope = req.params.id;
    await sql`
      UPDATE schedule_items
      SET paid = ${paid}, paid_at = ${paidAt}
      WHERE id = ${req.params.scheduleId}
        AND (
          client_id = ${scope}
          OR invoice_id = ${scope}
          OR invoice_id IN (
            SELECT id FROM clients WHERE group_id = ${scope} OR id = ${scope}
          )
          OR client_id IN (
            SELECT id FROM clients WHERE group_id = ${scope} OR id = ${scope}
          )
        )
    `;
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

export default router;
