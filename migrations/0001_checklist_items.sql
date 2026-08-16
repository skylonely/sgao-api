CREATE TABLE checklist_items (
	visitor_id TEXT NOT NULL,
	trip_id TEXT NOT NULL,
	item_id TEXT NOT NULL,
	checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (visitor_id, trip_id, item_id)
);
