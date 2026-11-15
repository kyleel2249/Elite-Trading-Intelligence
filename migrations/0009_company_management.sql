-- ETI company management: departments, roles, budgets, expenses, revenue attribution, objectives, metrics and an append-only activity log.
-- Amounts are integer cents. The same statements are embedded in worker/company/schema.ts.

CREATE TABLE IF NOT EXISTS company_departments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mission TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  head_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS company_members (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  department_id TEXT NOT NULL DEFAULT '*',
  role TEXT NOT NULL CHECK (role IN ('executive','department_head','finance_approver','accountant','auditor','member')),
  display_name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, department_id, role)
);

CREATE INDEX IF NOT EXISTS idx_company_members_user ON company_members (user_id, active);

CREATE TABLE IF NOT EXISTS company_budgets (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  period TEXT NOT NULL,
  allocated_cents INTEGER NOT NULL CHECK (allocated_cents >= 0),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_budgets_dept ON company_budgets (department_id, period, status);

CREATE TABLE IF NOT EXISTS company_expenses (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  paid_by TEXT,
  paid_at INTEGER,
  payment_reference TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_expenses_dept ON company_expenses (department_id, period, status);

CREATE TABLE IF NOT EXISTS company_revenue (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  source TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','verified')),
  recorded_by TEXT NOT NULL,
  verified_by TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_revenue_dept ON company_revenue (department_id, period, status);

CREATE TABLE IF NOT EXISTS company_objectives (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  title TEXT NOT NULL,
  metric TEXT NOT NULL DEFAULT '',
  target_value REAL NOT NULL,
  current_value REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','missed','cancelled')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_objectives_dept ON company_objectives (department_id, status);

CREATE TABLE IF NOT EXISTS company_metrics (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_company_metrics_dept ON company_metrics (department_id, created_at);

CREATE TABLE IF NOT EXISTS company_activity (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL DEFAULT '*',
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_company_activity_dept ON company_activity (department_id, at);
