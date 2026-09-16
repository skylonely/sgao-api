CREATE TABLE IF NOT EXISTS account_navigation_profiles (
  account_id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
