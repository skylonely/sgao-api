-- Additive: existing Todo, navigation and anonymous checklist tables are untouched.
CREATE TABLE IF NOT EXISTS account_notes (
  account_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  PRIMARY KEY (account_id, note_id)
);
CREATE INDEX IF NOT EXISTS account_notes_updated ON account_notes (account_id, updated_at DESC);
