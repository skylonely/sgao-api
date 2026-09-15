CREATE TABLE IF NOT EXISTS account_profiles (
  account_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_checklists (
  account_id TEXT NOT NULL,
  checklist_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, checklist_id),
  UNIQUE (account_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_account_checklists_position
  ON account_checklists (account_id, position);

CREATE TABLE IF NOT EXISTS account_checklist_items (
  account_id TEXT NOT NULL,
  checklist_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  label TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, checklist_id, item_id),
  FOREIGN KEY (account_id, checklist_id)
    REFERENCES account_checklists (account_id, checklist_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_checklist_items_position
  ON account_checklist_items (account_id, checklist_id, position);
