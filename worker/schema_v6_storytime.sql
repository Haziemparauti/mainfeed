-- Mainfeed D1 migration → v6 (Storytime: arc manifest + day-tracking + pre-bake)
-- Run: wrangler d1 execute mainfeed-db --remote --file=worker/schema_v6_storytime.sql
--
-- Implements the 2026-05-29 model (see memory: mainfeed_session_2026-05-29_decisions):
--   • Per-user saga anchor (saga_started_at) + current arc.
--   • Per-piece STORY COORDINATES baked at bake time: arc / day / scene / wardrobe_phase.
--   • arc_manifest : the authored source-of-truth the bake reads (one row per piece).
--   • bake_jobs    : pre-bake job queue (replaces the daily-generation cron).
--   • stock_library arc/wardrobe_phase mapping so the bake picks the right clip.
--
-- Terminology: arc = 30 days · wardrobe_phase = 5 days (1-6) · day = 1-30 · scene = 1-10.
-- Reuses existing columns: generated_pieces.caption (= in-app monologue, NEVER burned in),
--   .type ('video'|'gif'|'image'), .reveal_at, .status, .r2_key, .duration.
-- NOTE: column-adds are plain ALTERs (run once). Tables/indexes use IF NOT EXISTS.
-- Subscription/trial columns are intentionally NOT here — they land in the paywall
-- migration during Step 3 (website/functions).

-- users: saga anchor + current arc ------------------------------------------
ALTER TABLE users ADD COLUMN arc TEXT;                 -- e.g. 'jungle_survival'
ALTER TABLE users ADD COLUMN saga_started_at INTEGER;  -- anchor (epoch ms). current day = floor((now-anchor)/86400000)+1
CREATE INDEX IF NOT EXISTS idx_users_arc ON users(arc, saga_started_at);

-- generated_pieces: story coordinates ---------------------------------------
ALTER TABLE generated_pieces ADD COLUMN arc TEXT;
ALTER TABLE generated_pieces ADD COLUMN day INTEGER;             -- 1..30 (also the DAY N on the bug)
ALTER TABLE generated_pieces ADD COLUMN scene INTEGER;           -- 1..10 (order within the day)
ALTER TABLE generated_pieces ADD COLUMN wardrobe_phase INTEGER;  -- 1..6
ALTER TABLE generated_pieces ADD COLUMN bake_job_id TEXT;        -- which bake produced it
CREATE INDEX IF NOT EXISTS idx_pieces_user_arc_day
  ON generated_pieces(user_id, arc, day, scene);

-- stock_library: arc / wardrobe_phase so the bake filters to the right clip --
ALTER TABLE stock_library ADD COLUMN arc TEXT;
ALTER TABLE stock_library ADD COLUMN wardrobe_phase INTEGER;
CREATE INDEX IF NOT EXISTS idx_stock_arc_phase
  ON stock_library(arc, wardrobe_phase, scenario, appearance_bucket, active);

-- arc_manifest: the authored SOURCE OF TRUTH (one row per piece) -------------
-- Seeded from the authoring file. The bake reads this to render each user's saga.
-- {subject}/{bucket_phrase} slots inside `prompt` fill from the user's appearance
-- bucket + gender at bake time. The manifest is USER-AGNOSTIC — uniqueness comes
-- from the face-swap, not the script.
CREATE TABLE IF NOT EXISTS arc_manifest (
  arc            TEXT    NOT NULL,
  day            INTEGER NOT NULL,            -- 1..30
  scene          INTEGER NOT NULL,            -- 1..10
  format         TEXT    NOT NULL,            -- 'video' | 'gif' | 'image'
  wardrobe_phase INTEGER NOT NULL,            -- 1..6
  block          TEXT,                        -- optional narrative tag (dawn/mid-morning/...)
  location       TEXT,                        -- signature location tag (continuity)
  is_cliffhanger INTEGER NOT NULL DEFAULT 0,  -- 1 = the day's last / hook scene
  prompt         TEXT    NOT NULL,            -- generation prompt (with {subject} slot)
  caption        TEXT    NOT NULL,            -- in-app monologue (never burned into pixels)
  PRIMARY KEY (arc, day, scene)
);
CREATE INDEX IF NOT EXISTS idx_manifest_arc_day ON arc_manifest(arc, day, scene);

-- bake_jobs: pre-bake job queue (replaces the daily-generation cron) ---------
CREATE TABLE IF NOT EXISTS bake_jobs (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL,
  arc              TEXT    NOT NULL,
  job_type         TEXT    NOT NULL,                 -- 'trial' | 'rest_of_arc' | 'next_arc'
  day_from         INTEGER NOT NULL,                 -- inclusive
  day_to           INTEGER NOT NULL,                 -- inclusive
  status           TEXT    NOT NULL DEFAULT 'queued',-- queued | running | completed | failed
  priority         TEXT    NOT NULL DEFAULT 'low',   -- 'high' (signup, user waiting) | 'low' (overnight)
  pieces_total     INTEGER NOT NULL DEFAULT 0,
  pieces_completed INTEGER NOT NULL DEFAULT 0,
  pieces_failed    INTEGER NOT NULL DEFAULT 0,
  queued_at        INTEGER NOT NULL,
  started_at       INTEGER,
  completed_at     INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_bake_jobs_status_priority ON bake_jobs(status, priority, queued_at);
CREATE INDEX IF NOT EXISTS idx_bake_jobs_user ON bake_jobs(user_id);
