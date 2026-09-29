-- Company-only admin console: one row per authorized admin request, written before data is returned.
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_audit_created_at ON admin_audit(created_at, id);
