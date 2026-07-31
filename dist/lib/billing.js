export function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}
export function additionalWorksSum(items) {
    return round2((items || []).reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.rate) || 0), 0));
}
export function calcTotals(input) {
    const area = Number(input.areaSqft) || 0;
    const rate = Number(input.costPerSqft) || 0;
    const pct = Number(input.feePercent) || 0;
    const fixed = Number(input.fixedAmount) || 0;
    const advance = Number(input.advanceAmount) || 0;
    const additionalTotal = additionalWorksSum(input.additionalWorks);
    let projectCost = 0;
    let feeAmount = 0;
    if (input.feeMode === "percentage") {
        projectCost = round2(area * rate);
        feeAmount = round2(projectCost * (pct / 100));
    }
    else if (input.feeMode === "fixed") {
        projectCost = fixed;
        feeAmount = fixed;
    }
    else {
        projectCost = round2(area * rate);
        feeAmount = projectCost;
    }
    const totalBill = input.feeMode === "percentage"
        ? round2(projectCost + feeAmount + additionalTotal)
        : round2(feeAmount + additionalTotal);
    return {
        projectCost,
        feeAmount,
        additionalTotal,
        totalBill,
        balance: round2(Math.max(0, totalBill - advance)),
    };
}
export function addMonths(isoDate, months) {
    const d = new Date(isoDate + "T00:00:00");
    d.setMonth(d.getMonth() + months);
    return d.toISOString().slice(0, 10);
}
export function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
export function buildSchedule(input) {
    const rows = [];
    const start = input.startDate || todayISO();
    if (input.advanceAmount > 0 && input.advanceDate) {
        rows.push({
            clientId: input.clientId,
            kind: "advance",
            label: "Advance",
            amount: round2(input.advanceAmount),
            dueDate: input.advanceDate,
        });
    }
    if (input.balance <= 0 || input.paymentPlan === "none")
        return rows;
    if (input.paymentPlan === "one_time") {
        rows.push({
            clientId: input.clientId,
            kind: "one_time",
            label: "Full balance",
            amount: round2(input.balance),
            dueDate: input.oneTimeDueDate || start,
        });
        return rows;
    }
    if (input.paymentPlan === "installment") {
        const months = Math.max(1, Number(input.installmentMonths) || 1);
        let count = months;
        let interval = 1;
        if (input.installmentMode === "count_over_months") {
            count = Math.max(1, Number(input.installmentCount) || 1);
            interval = months / count;
        }
        const custom = (input.installmentDueDates || []).filter(Boolean);
        const base = round2(input.balance / count);
        let allocated = 0;
        for (let i = 0; i < count; i++) {
            const isLast = i === count - 1;
            const amount = isLast ? round2(input.balance - allocated) : base;
            allocated = round2(allocated + amount);
            rows.push({
                clientId: input.clientId,
                kind: "installment",
                label: `Installment ${i + 1}`,
                amount,
                dueDate: custom[i] ||
                    addMonths(custom[0] || start, Math.round(interval * i)),
            });
        }
        return rows;
    }
    for (const stage of input.stages || []) {
        if (!stage.name && !stage.amount)
            continue;
        rows.push({
            clientId: input.clientId,
            kind: "stage",
            label: stage.name || "Stage",
            amount: round2(Number(stage.amount) || 0),
            dueDate: stage.dueDate || start,
        });
    }
    return rows;
}
export function mapClientRow(row) {
    let additionalWorks = [];
    const raw = row.additional_works;
    if (typeof raw === "string") {
        try {
            additionalWorks = JSON.parse(raw);
        }
        catch {
            additionalWorks = [];
        }
    }
    else if (Array.isArray(raw)) {
        additionalWorks = raw;
    }
    const additionalTotal = additionalWorksSum(additionalWorks);
    return {
        id: row.id,
        groupId: row.group_id || row.id,
        invoiceNo: row.invoice_no,
        name: row.name,
        location: row.location,
        projectName: row.project_name,
        feeMode: row.fee_mode,
        areaSqft: row.area_sqft != null ? Number(row.area_sqft) : null,
        costPerSqft: row.cost_per_sqft != null ? Number(row.cost_per_sqft) : null,
        feePercent: row.fee_percent != null ? Number(row.fee_percent) : null,
        projectCost: Number(row.project_cost),
        feeAmount: Number(row.fee_amount),
        fixedAmount: row.fixed_amount != null ? Number(row.fixed_amount) : null,
        additionalWorks,
        additionalTotal,
        totalBill: Number(row.total_bill),
        advanceAmount: Number(row.advance_amount),
        advanceDate: (() => {
            const raw = row.advance_date;
            if (!raw)
                return null;
            if (raw instanceof Date) {
                const y = raw.getFullYear();
                const m = String(raw.getMonth() + 1).padStart(2, "0");
                const d = String(raw.getDate()).padStart(2, "0");
                return `${y}-${m}-${d}`;
            }
            const s = String(raw);
            const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
            return m ? m[1] : s.slice(0, 10);
        })(),
        balance: Number(row.balance),
        paymentPlan: row.payment_plan,
        installmentMode: row.installment_mode || null,
        installmentMonths: row.installment_months != null ? Number(row.installment_months) : null,
        installmentCount: row.installment_count != null ? Number(row.installment_count) : null,
        oneTimeDueDate: row.one_time_due_date
            ? String(row.one_time_due_date).slice(0, 10)
            : null,
        createdAt: (() => {
            const raw = row.created_at;
            if (raw instanceof Date)
                return raw.toISOString();
            const s = String(raw || "");
            const d = new Date(s);
            return Number.isNaN(d.getTime()) ? s : d.toISOString();
        })(),
    };
}
export function toDateOnly(raw) {
    if (raw == null || raw === "")
        return null;
    if (raw instanceof Date) {
        const y = raw.getFullYear();
        const m = String(raw.getMonth() + 1).padStart(2, "0");
        const d = String(raw.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }
    const s = String(raw);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m)
        return m[1];
    const d = new Date(s);
    if (Number.isNaN(d.getTime()))
        return s.slice(0, 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function mapScheduleRow(row) {
    return {
        id: row.id,
        clientId: row.client_id,
        invoiceId: row.invoice_id || row.client_id,
        kind: row.kind,
        label: row.label,
        amount: Number(row.amount),
        dueDate: toDateOnly(row.due_date) || todayISO(),
        paid: Boolean(row.paid),
        paidAt: toDateOnly(row.paid_at),
    };
}
