CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  body TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_mappings (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, attempt)
);

CREATE TABLE IF NOT EXISTS outbound_events (
  message_id TEXT PRIMARY KEY NOT NULL,
  sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
