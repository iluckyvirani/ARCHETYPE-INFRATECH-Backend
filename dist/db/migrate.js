import { sql } from "../db.js";
export async function migrate() {
    await sql `
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      invoice_no TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      project_name TEXT NOT NULL,
      fee_mode TEXT NOT NULL CHECK (fee_mode IN ('percentage', 'fixed', 'area_sqft')),
      area_sqft NUMERIC,
      cost_per_sqft NUMERIC,
      fee_percent NUMERIC,
      project_cost NUMERIC NOT NULL DEFAULT 0,
      fee_amount NUMERIC NOT NULL DEFAULT 0,
      fixed_amount NUMERIC,
      additional_works JSONB NOT NULL DEFAULT '[]'::jsonb,
      total_bill NUMERIC NOT NULL DEFAULT 0,
      advance_amount NUMERIC NOT NULL DEFAULT 0,
      advance_date DATE,
      balance NUMERIC NOT NULL DEFAULT 0,
      payment_plan TEXT NOT NULL DEFAULT 'none',
      installment_mode TEXT,
      installment_months INT,
      installment_count INT,
      one_time_due_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
    await sql `
    CREATE TABLE IF NOT EXISTS schedule_items (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('advance', 'one_time', 'installment', 'stage')),
      label TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      due_date DATE NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT FALSE,
      paid_at DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
    await sql `
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      schedule_item_id TEXT REFERENCES schedule_items(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      due_date DATE NOT NULL,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
    await sql `CREATE INDEX IF NOT EXISTS idx_schedule_client ON schedule_items(client_id)`;
    await sql `CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(due_date)`;
    await sql `
    ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS additional_works JSONB NOT NULL DEFAULT '[]'::jsonb
  `;
    await sql `
    ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS group_id TEXT
  `;
    await sql `
    UPDATE clients SET group_id = id WHERE group_id IS NULL
  `;
    await sql `
    ALTER TABLE schedule_items
    ADD COLUMN IF NOT EXISTS invoice_id TEXT
  `;
    await sql `
    UPDATE schedule_items SET invoice_id = client_id WHERE invoice_id IS NULL
  `;
}
