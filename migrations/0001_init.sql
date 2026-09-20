CREATE TABLE IF NOT EXISTS orbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  question TEXT,
  cards TEXT NOT NULL,
  reading TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(device_id, at)
);
CREATE INDEX IF NOT EXISTS idx_orbs_device ON orbs(device_id, at);
