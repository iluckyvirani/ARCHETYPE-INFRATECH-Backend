import { Router } from "express";
import { randomUUID } from "crypto";
import { sql } from "../db.js";
import {
  addMonths,
  buildSchedule,
  calcTotals,
  mapClientRow,
  mapScheduleRow,
  round2,
  toDateOnly,
  todayISO,
  type ClientPayload,
  type FeeMode,
} from "../lib/billing.js";

const router = Router();

function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Client / group ID format: A.I-001 … A.I-999, then A.I-1000+ */
function parseClientGroupNo(groupId: string): number {
  const m = String(groupId || "").trim().match(/^A\.I-(\d+)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : 0;
}

function formatClientGroupId(n: number): string {
  const num = Math.max(1, Math.floor(n));
  return `A.I-${String(num).padStart(3, "0")}`;
}

async function nextClientGroupId(): Promise<string> {
  const rows = await sql`
    SELECT DISTINCT group_id FROM clients WHERE group_id IS NOT NULL
  `;
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, parseClientGroupNo(String(row.group_id)));
  }
  return formatClientGroupId(max + 1);
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
  const isQuotation = body.documentType === "quotation";
  const documentType = isQuotation ? "quotation" : "invoice";
  const advance = isQuotation ? 0 : Number(body.advanceAmount) || 0;
  const plan = isQuotation
    ? "none"
    : totals.balance <= 0
      ? "none"
      : body.paymentPlan || "none";
  // Quotations are estimates — not receivables
  const balance = isQuotation ? 0 : totals.balance;

  await sql`
    INSERT INTO clients (
      id, group_id, invoice_no, document_type, name, location, project_name, work_types, work_type_custom, fee_mode,
      area_sqft, cost_per_sqft, floors, fee_percent, project_cost, fee_amount,
      fixed_amount, additional_works, visit_included, visit_fee,
      total_bill, advance_amount, advance_date, balance,
      payment_plan, installment_mode, installment_months, installment_count,
      one_time_due_date
    ) VALUES (
      ${invoiceId},
      ${groupId},
      ${invoiceNo},
      ${documentType},
      ${name.trim()},
      ${body.location.trim()},
      ${body.projectName.trim()},
      ${JSON.stringify(body.workTypes || [])},
      ${(body.workTypeCustom || "").trim() || null},
      ${body.feeMode},
      ${body.areaSqft ?? null},
      ${body.costPerSqft ?? null},
      ${JSON.stringify(
        (body.floors || [])
          .map((f) => ({
            label: String(f.label || "").trim(),
            areaSqft: Number(f.areaSqft) || 0,
            costPerSqft: Number(f.costPerSqft) || 0,
          }))
          .filter((f) => f.label && f.areaSqft > 0 && f.costPerSqft > 0)
      )},
      ${body.feePercent ?? null},
      ${totals.projectCost},
      ${totals.feeAmount},
      ${body.fixedAmount ?? null},
      ${JSON.stringify(
        (body.additionalWorks || []).filter(
          (w) => w.name?.trim() && (Number(w.qty) > 0 || Number(w.rate) > 0)
        )
      )},
      ${Boolean(body.visitIncluded)},
      ${totals.visitFee},
      ${totals.totalBill},
      ${advance},
      ${advance > 0 ? body.advanceDate || null : null},
      ${balance},
      ${plan},
      ${plan === "installment" ? body.installmentMode || null : null},
      ${plan === "installment" ? body.installmentMonths || null : null},
      ${plan === "installment" ? body.installmentCount || null : null},
      ${plan === "one_time" ? body.oneTimeDueDate || null : null}
    )
  `;

  const scheduleRows = isQuotation
    ? []
    : buildSchedule({
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

/** Business-wide ledger: total billed, total received, total due (invoices only — quotations excluded) */
router.get("/ledger/summary", async (_req, res) => {
  try {
    const billedRows = await sql`
      SELECT
        COALESCE(SUM(total_bill), 0) AS total_billed,
        COUNT(*) AS invoice_count,
        COUNT(DISTINCT COALESCE(group_id, id)) AS client_count
      FROM clients
      WHERE document_type != 'quotation'
    `;
    const receivedRows = await sql`
      SELECT COALESCE(SUM(s.paid_amount), 0) AS total_received
      FROM schedule_items s
      JOIN clients c ON c.id = COALESCE(s.invoice_id, s.client_id)
      WHERE c.document_type != 'quotation' AND s.paid = TRUE
    `;
    const pendingRows = await sql`
      SELECT COUNT(*) AS pending_count
      FROM schedule_items s
      JOIN clients c ON c.id = COALESCE(s.invoice_id, s.client_id)
      WHERE c.document_type != 'quotation' AND s.paid = FALSE
    `;

    const totalBilled = round2(Number(billedRows[0]?.total_billed) || 0);
    const totalReceived = round2(Number(receivedRows[0]?.total_received) || 0);
    const totalDue = round2(Math.max(0, totalBilled - totalReceived));

    res.json({
      totalBilled,
      totalReceived,
      totalDue,
      invoiceCount: Number(billedRows[0]?.invoice_count) || 0,
      clientCount: Number(billedRows[0]?.client_count) || 0,
      pendingCount: Number(pendingRows[0]?.pending_count) || 0,
    });
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

/** Update one invoice (and optionally sync client name/location across the group) */
router.patch("/invoice/:invoiceId", async (req, res) => {
  try {
    const invoiceId = req.params.invoiceId;
    const body = req.body as ClientPayload & { syncClientInfo?: boolean };
    const existing = await sql`SELECT * FROM clients WHERE id = ${invoiceId}`;
    if (!existing[0]) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    const name = String(body?.name || existing[0].name).trim();
    const location = String(body?.location || existing[0].location).trim();
    const projectName = String(body?.projectName || "").trim();
    if (!name || !location || !projectName) {
      res.status(400).json({ error: "name, location, projectName required" });
      return;
    }
    if (existing[0].completed) {
      res.status(400).json({ error: "Completed invoices cannot be edited" });
      return;
    }

    const feeMode = body.feeMode || (existing[0].fee_mode as FeeMode);
    const isQuotation =
      body.documentType === "quotation" ||
      existing[0].document_type === "quotation";
    const advance = isQuotation
      ? 0
      : Number(body.advanceAmount ?? existing[0].advance_amount) || 0;
    const totals = calcTotals({
      feeMode,
      areaSqft: body.areaSqft ?? null,
      costPerSqft: body.costPerSqft ?? null,
      feePercent: body.feePercent ?? null,
      fixedAmount: body.fixedAmount ?? null,
      advanceAmount: advance,
      additionalWorks: body.additionalWorks || [],
      visitIncluded: body.visitIncluded !== false,
      visitFee: body.visitFee ?? 0,
    });
    const balance = isQuotation ? 0 : totals.balance;

    await sql`
      UPDATE clients SET
        name = ${name},
        location = ${location},
        project_name = ${projectName},
        work_types = ${JSON.stringify(body.workTypes || [])},
        work_type_custom = ${(body.workTypeCustom || "").trim() || null},
        fee_mode = ${feeMode},
        area_sqft = ${body.areaSqft ?? null},
        cost_per_sqft = ${body.costPerSqft ?? null},
        floors = ${JSON.stringify(
          (body.floors || [])
            .map((f) => ({
              label: String(f.label || "").trim(),
              areaSqft: Number(f.areaSqft) || 0,
              costPerSqft: Number(f.costPerSqft) || 0,
            }))
            .filter((f) => f.label && f.areaSqft > 0 && f.costPerSqft > 0)
        )},
        fee_percent = ${body.feePercent ?? null},
        project_cost = ${totals.projectCost},
        fee_amount = ${totals.feeAmount},
        fixed_amount = ${body.fixedAmount ?? null},
        additional_works = ${JSON.stringify(
          (body.additionalWorks || []).filter(
            (w) => w.name?.trim() && (Number(w.qty) > 0 || Number(w.rate) > 0)
          )
        )},
        visit_included = ${Boolean(body.visitIncluded)},
        visit_fee = ${totals.visitFee},
        total_bill = ${totals.totalBill},
        advance_amount = ${advance},
        advance_date = ${advance > 0 ? body.advanceDate || null : null},
        balance = ${balance},
        payment_plan = ${isQuotation ? "none" : existing[0].payment_plan}
      WHERE id = ${invoiceId}
    `;

    if (body.syncClientInfo !== false) {
      const groupId =
        (existing[0].group_id as string) || String(existing[0].id);
      await sql`
        UPDATE clients
        SET name = ${name}, location = ${location}
        WHERE group_id = ${groupId} OR id = ${groupId}
      `;
    }

    // Keep advance schedule row amount in sync when present
    if (advance > 0) {
      await sql`
        UPDATE schedule_items
        SET amount = ${advance},
            due_date = COALESCE(${body.advanceDate || null}, due_date)
        WHERE invoice_id = ${invoiceId} AND kind = 'advance'
      `;
    }

    // Rebalance unpaid EMI/installment/stage rows to match the edited total.
    // Already-collected rows are left untouched; the remaining balance is
    // redistributed across unpaid rows in their existing proportions.
    if (!isQuotation) {
      const rows = (await sql`
        SELECT * FROM schedule_items
        WHERE invoice_id = ${invoiceId} AND kind != 'advance'
        ORDER BY due_date ASC, created_at ASC
      `) as Record<string, unknown>[];
      const paidRows = rows.filter((r) => Boolean(r.paid));
      const unpaidRows = rows.filter((r) => !r.paid);
      const alreadyCollected = paidRows.reduce(
        (s, r) => s + (Number(r.paid_amount) || Number(r.amount) || 0),
        0
      );
      const remaining = round2(Math.max(0, balance - alreadyCollected));

      if (unpaidRows.length > 0) {
        const oldUnpaidTotal = unpaidRows.reduce(
          (s, r) => s + (Number(r.amount) || 0),
          0
        );
        let allocated = 0;
        for (let i = 0; i < unpaidRows.length; i++) {
          const row = unpaidRows[i];
          const isLast = i === unpaidRows.length - 1;
          let amount: number;
          if (isLast) {
            amount = round2(remaining - allocated);
          } else if (oldUnpaidTotal > 0) {
            amount = round2((Number(row.amount) / oldUnpaidTotal) * remaining);
          } else {
            amount = round2(remaining / unpaidRows.length);
          }
          amount = Math.max(0, amount);
          allocated = round2(allocated + amount);
          await sql`
            UPDATE schedule_items SET amount = ${amount} WHERE id = ${row.id}
          `;
        }
      } else if (remaining > 0 && existing[0].payment_plan !== "none") {
        // No unpaid rows left to absorb the increase — open a new one
        const schId = id("sch");
        const dueDate = body.oneTimeDueDate || todayISO();
        const kind =
          existing[0].payment_plan === "stage"
            ? "stage"
            : existing[0].payment_plan === "one_time"
              ? "one_time"
              : "installment";
        await sql`
          INSERT INTO schedule_items (
            id, client_id, invoice_id, kind, label, amount, due_date, paid, paid_at
          ) VALUES (
            ${schId}, ${invoiceId}, ${invoiceId}, ${kind},
            ${"Balance due (adjusted)"}, ${remaining}, ${dueDate}, ${false}, ${null}
          )
        `;
        await sql`
          INSERT INTO notifications (
            id, client_id, schedule_item_id, title, message, due_date, read
          ) VALUES (
            ${id("ntf")}, ${invoiceId}, ${schId},
            ${"Payment due"},
            ${`${name} — Balance due (adjusted) ₹${remaining.toLocaleString("en-IN")} due ${dueDate}`},
            ${dueDate}, ${false}
          )
        `;
      }
    }

    const updated = await sql`SELECT * FROM clients WHERE id = ${invoiceId}`;
    res.json(mapClientRow(updated[0]));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

/** Settle all dues and mark customer complete */
router.post("/group/:groupId/complete", async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const today = todayISO();
    const invoices = await sql`
      SELECT id FROM clients
      WHERE group_id = ${groupId} OR id = ${groupId}
    `;
    if (!invoices[0]) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const ids = invoices.map((r) => String(r.id));
    for (const invId of ids) {
      await sql`
        UPDATE schedule_items
        SET paid = TRUE, paid_at = COALESCE(paid_at, ${today}), paid_amount = amount
        WHERE paid = FALSE
          AND (
            invoice_id = ${invId}
            OR client_id = ${invId}
            OR client_id = ${groupId}
          )
      `;
      await sql`
        UPDATE clients
        SET balance = 0, completed = TRUE, completed_at = ${today}
        WHERE id = ${invId}
      `;
    }
    await sql`
      UPDATE clients
      SET completed = TRUE, completed_at = ${today}, balance = 0
      WHERE group_id = ${groupId} OR id = ${groupId}
    `;
    res.json({ ok: true, completed: true, completedAt: today });
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
    const groupId = await nextClientGroupId();
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

    const existing = await sql`
      SELECT * FROM schedule_items
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
    const item = existing[0] as Record<string, unknown> | undefined;
    if (!item) {
      res.status(404).json({ error: "Schedule item not found" });
      return;
    }

    const scheduledAmount = Number(item.amount) || 0;
    const rawPaidAmount = req.body?.paidAmount;
    const hasPaidAmount =
      rawPaidAmount !== undefined && rawPaidAmount !== null && rawPaidAmount !== "";
    const paidAmount = paid
      ? round2(Math.max(0, hasPaidAmount ? Number(rawPaidAmount) || 0 : scheduledAmount))
      : 0;

    await sql`
      UPDATE schedule_items
      SET paid = ${paid}, paid_at = ${paidAt}, paid_amount = ${paidAmount}
      WHERE id = ${req.params.scheduleId}
    `;

    // Roll a shortfall into the next upcoming EMI, or credit an overpayment against it
    let diff = paid ? round2(scheduledAmount - paidAmount) : 0;
    if (diff !== 0) {
      const clientRef = String(item.invoice_id || item.client_id);
      const dueDate = toDateOnly(item.due_date) || todayISO();

      const upcoming = await sql`
        SELECT * FROM schedule_items
        WHERE (invoice_id = ${clientRef} OR client_id = ${clientRef})
          AND id != ${req.params.scheduleId}
          AND paid = FALSE
          AND kind != 'advance'
        ORDER BY due_date ASC, created_at ASC
      `;

      for (const next of upcoming) {
        if (diff === 0) break;
        const nextId = String(next.id);
        const nextAmount = Number(next.amount) || 0;
        if (diff > 0) {
          // Shortfall: add the unpaid remainder onto the next due EMI
          await sql`
            UPDATE schedule_items SET amount = ${round2(nextAmount + diff)}
            WHERE id = ${nextId}
          `;
          diff = 0;
        } else {
          // Overpayment: credit it against the next EMI, cascading if fully covered
          const credit = Math.min(nextAmount, -diff);
          const remaining = round2(nextAmount - credit);
          if (remaining <= 0) {
            await sql`
              UPDATE schedule_items
              SET amount = 0, paid = TRUE, paid_at = ${paidAt}, paid_amount = ${nextAmount}
              WHERE id = ${nextId}
            `;
            diff = round2(diff + credit);
          } else {
            await sql`
              UPDATE schedule_items SET amount = ${remaining}
              WHERE id = ${nextId}
            `;
            diff = 0;
          }
        }
      }

      if (diff > 0) {
        // No upcoming EMI to absorb the shortfall — open a new carried-balance row
        const schId = id("sch");
        const newDueDate = addMonths(dueDate, 1);
        const carryKind = item.kind === "advance" ? "installment" : String(item.kind);
        await sql`
          INSERT INTO schedule_items (
            id, client_id, invoice_id, kind, label, amount, due_date, paid, paid_at
          ) VALUES (
            ${schId}, ${clientRef}, ${clientRef}, ${carryKind},
            ${"Balance due (carried forward)"}, ${diff}, ${newDueDate}, ${false}, ${null}
          )
        `;
        const clientRows = await sql`SELECT name FROM clients WHERE id = ${clientRef}`;
        const clientName = clientRows[0] ? String(clientRows[0].name) : "Client";
        await sql`
          INSERT INTO notifications (
            id, client_id, schedule_item_id, title, message, due_date, read
          ) VALUES (
            ${id("ntf")}, ${clientRef}, ${schId},
            ${"Payment due"},
            ${`${clientName} — Balance due (carried forward) ₹${diff.toLocaleString("en-IN")} due ${newDueDate}`},
            ${newDueDate}, ${false}
          )
        `;
      }
    }

    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    res.status(500).json({ error: message });
  }
});

export default router;
