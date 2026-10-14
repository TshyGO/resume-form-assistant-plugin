CREATE TABLE email_delivery (
  report_date TEXT NOT NULL,
  recipient_slot INTEGER NOT NULL CHECK (recipient_slot IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'failed', 'unknown')),
  updated_at TEXT NOT NULL,
  error_code TEXT,
  PRIMARY KEY (report_date, recipient_slot)
);
