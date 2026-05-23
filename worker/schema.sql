-- Mainfeed D1 schema (v0)
-- Run: wrangler d1 execute mainfeed-db --remote --file=schema.sql

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  liveness_verified INTEGER NOT NULL DEFAULT 0,
  liveness_verified_at INTEGER,
  consent_18 INTEGER NOT NULL DEFAULT 0,
  consent_ai INTEGER NOT NULL DEFAULT 0,
  consent_terms INTEGER NOT NULL DEFAULT 0,
  selfies_count INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free',
  paddle_customer_id TEXT,
  daily_pieces_count INTEGER NOT NULL DEFAULT 0,
  daily_pieces_reset_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Diary entries
CREATE TABLE IF NOT EXISTS diary_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pieces_generated INTEGER NOT NULL DEFAULT 0,
  moderation_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_diary_user_created ON diary_entries(user_id, created_at DESC);

-- Generated pieces (the feed content)
CREATE TABLE IF NOT EXISTS generated_pieces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  diary_entry_id TEXT,
  type TEXT NOT NULL,                  -- 'image' | 'video'
  caption TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  duration REAL,
  generation_cost_cents INTEGER,
  generation_provider TEXT,            -- 'fal-flux-pulid' | 'fal-pixverse' | etc.
  generation_prompt TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  share_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (diary_entry_id) REFERENCES diary_entries(id)
);

CREATE INDEX IF NOT EXISTS idx_pieces_user_created ON generated_pieces(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pieces_diary ON generated_pieces(diary_entry_id);

-- Rate limits
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Reports (user-flagged content)
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  piece_id TEXT NOT NULL,
  reporter_user_id TEXT,
  reporter_ip TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'resolved' | 'takedown'
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (piece_id) REFERENCES generated_pieces(id)
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- Stock library metadata (pre-tracked clips for surgical face-swap, v1.1)
CREATE TABLE IF NOT EXISTS stock_library (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  type TEXT NOT NULL,                  -- 'image' | 'video'
  source TEXT NOT NULL,                -- 'storyblocks' | 'envato' | 'pexels' | 'ai-generated'
  source_id TEXT,
  duration REAL,
  width INTEGER,
  height INTEGER,
  mood TEXT,                           -- 'shocked' | 'panicked' | 'sleepy' | etc.
  scenario TEXT,                       -- 'waking-up' | 'office' | 'wedding' | etc.
  composition TEXT,                    -- 'close-up' | 'mid' | 'wide'
  tags TEXT,                           -- comma-separated
  face_track_data TEXT,                -- JSON: bounding boxes per frame for video, single bbox for image
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_active_mood ON stock_library(active, mood);
CREATE INDEX IF NOT EXISTS idx_stock_active_scenario ON stock_library(active, scenario);
