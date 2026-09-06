//! 物理 schema(v1)与迁移注册表。
//!
//! 设计要点(均为冻结契约,见 docs/desktop-mvp/):
//! - applications 无 (company,url)/(company,title) 唯一约束:同公司多岗、同岗重复申请并存。
//! - events 按 (application_id, event_sequence) 唯一;收件箱事件(NULL 申请)用档案级序号的局部唯一索引。
//! - 附件字节不进库:attachment_blobs 只存 sha256、大小、受控相对路径、引用计数。
//! - message_receipts 持久化提交回执(含 sourceRestoreEpoch 与 payloadSha256)与永久删除墓碑。
//! - schema_migrations 记录迁移历史;PRAGMA user_version 为权威版本。

pub const SCHEMA_VERSION: i64 = 1;

pub struct Migration {
    pub to_version: i64,
    pub description: &'static str,
    pub sql: &'static str,
}

pub const V1_SCHEMA: &str = r#"
CREATE TABLE archive_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  archive_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  display_name TEXT
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  company_normalized TEXT NOT NULL,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  source_url TEXT,
  dedupe_url TEXT,
  location TEXT,
  notes TEXT,
  current_stage TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  reply_evidence_state TEXT NOT NULL DEFAULT 'none_imported',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  recycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (recycle_state IN ('active','recycled','purged')),
  origin TEXT NOT NULL CHECK (origin IN ('manual','plugin'))
);
-- 冻结规则:同公司多岗、同岗位重复申请可并存,禁止按公司或 URL 自动合并。
CREATE INDEX idx_applications_company ON applications(company_normalized);
CREATE INDEX idx_applications_dedupe ON applications(dedupe_url);
CREATE INDEX idx_applications_stage ON applications(current_stage);
CREATE INDEX idx_applications_recycle ON applications(recycle_state);
CREATE INDEX idx_applications_updated ON applications(updated_at);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id),
  event_sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT,
  occurred_precision TEXT NOT NULL
    CHECK (occurred_precision IN ('datetime','date','unknown')),
  recorded_at TEXT NOT NULL,
  time_zone TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual','plugin','import','ai_confirmed')),
  source_request_id TEXT,
  payload_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user','plugin','system'))
);
CREATE UNIQUE INDEX idx_events_app_seq
  ON events(application_id, event_sequence) WHERE application_id IS NOT NULL;
CREATE UNIQUE INDEX idx_events_inbox_seq
  ON events(event_sequence) WHERE application_id IS NULL;
CREATE INDEX idx_events_recorded ON events(recorded_at);

CREATE TABLE attachment_blobs (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  stored_rel_path TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  mime TEXT
);

CREATE TABLE reply_evidence (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id),
  kind TEXT NOT NULL CHECK (kind IN ('eml','screenshot','pdf','paste','unknown')),
  reply_class TEXT CHECK (reply_class IN
    ('auto_ack','assessment_invite','interview_invite','action_required',
     'offer','reject','other','unknown')),
  send_mode TEXT CHECK (send_mode IN ('human','automated','unknown')),
  blob_sha256 TEXT NOT NULL REFERENCES attachment_blobs(sha256),
  original_filename TEXT,
  imported_at TEXT NOT NULL,
  subject TEXT,
  from_addr TEXT,
  sent_at TEXT,
  sent_precision TEXT NOT NULL DEFAULT 'unknown'
    CHECK (sent_precision IN ('datetime','date','unknown')),
  sent_tz TEXT,
  body_extract TEXT
);
CREATE INDEX idx_evidence_app ON reply_evidence(application_id);
CREATE INDEX idx_evidence_blob ON reply_evidence(blob_sha256);

CREATE TABLE resume_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  template_name TEXT NOT NULL,
  template_version TEXT,
  sha256 TEXT NOT NULL,
  stored_rel_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  byte_size INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_app ON resume_snapshots(application_id);

CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  title TEXT NOT NULL,
  due_precision TEXT NOT NULL CHECK (due_precision IN ('datetime','date','none')),
  due_at_utc TEXT,
  due_date TEXT,
  time_zone TEXT,
  remind_at_utc TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  interview_round INTEGER,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_todos_app ON todos(application_id);
CREATE INDEX idx_todos_status ON todos(status);

CREATE TABLE ai_suggestions (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES reply_evidence(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','modified_confirmed','rejected','deferred')),
  candidate_application_ids TEXT NOT NULL DEFAULT '[]',
  suggested_stage TEXT,
  suggested_round INTEGER,
  suggested_reply_class TEXT NOT NULL CHECK (suggested_reply_class IN
    ('auto_ack','assessment_invite','interview_invite','action_required',
     'offer','reject','other','unknown')),
  suggested_send_mode TEXT NOT NULL CHECK (suggested_send_mode IN
    ('human','automated','unknown')),
  suggested_todos TEXT NOT NULL DEFAULT '[]',
  excerpt_refs TEXT,
  uncertainties TEXT,
  model_label TEXT,
  prompt_scope TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  approved_reply_class TEXT,
  approved_send_mode TEXT,
  approved_stage TEXT
);
CREATE INDEX idx_suggestions_evidence ON ai_suggestions(evidence_id);
CREATE INDEX idx_suggestions_status ON ai_suggestions(status);

-- 提交回执(产品需求 §8.11):业务事务内同步写入,随业务库备份。
-- sourceRestoreEpoch 是该写入提交时的历史身份,不授予当前写入权限。
CREATE TABLE message_receipts (
  archive_id TEXT NOT NULL,
  client_instance_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  source_restore_epoch TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  result_id TEXT,
  result_kind TEXT,
  operation_type TEXT NOT NULL,
  snapshot_id TEXT,
  chunk_index INTEGER,
  committed_at TEXT NOT NULL,
  purged INTEGER NOT NULL DEFAULT 0 CHECK (purged IN (0,1)),
  PRIMARY KEY (client_instance_id, message_id, source_restore_epoch)
);
CREATE INDEX idx_receipts_payload ON message_receipts(client_instance_id, payload_sha256);
CREATE INDEX idx_receipts_result ON message_receipts(result_id);
CREATE INDEX idx_receipts_chunk
  ON message_receipts(client_instance_id, snapshot_id, chunk_index, source_restore_epoch);

-- 快照分片上传的父记录与块账本(元数据;字节在 snapshots/ 目录,归 D08/D09 管理)。
CREATE TABLE snapshot_uploads (
  client_instance_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  application_id TEXT REFERENCES applications(id),
  chunk_count INTEGER NOT NULL,
  total_sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  template_name TEXT,
  template_version TEXT,
  source_restore_epoch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  full_acked INTEGER NOT NULL DEFAULT 0 CHECK (full_acked IN (0,1)),
  PRIMARY KEY (client_instance_id, snapshot_id)
);

CREATE TABLE snapshot_chunks (
  client_instance_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_message_id TEXT NOT NULL,
  chunk_sha256 TEXT NOT NULL,
  source_restore_epoch TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (client_instance_id, snapshot_id, chunk_index)
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
"#;

pub const MIGRATIONS: &[Migration] = &[Migration {
    to_version: 1,
    description: "initial schema: applications, events, evidence metadata, snapshots, todos, ai suggestions, receipts, snapshot chunk ledger",
    sql: V1_SCHEMA,
}];
