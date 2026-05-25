-- Mainfeed D1 migration → v5 (bucket-matched DreamID-V swap)
-- Run: wrangler d1 execute mainfeed-db --remote --file=worker/schema_v5.sql
--
-- Adds:
--   users.appearance_bucket          → which of the 40 hair+skin buckets the user
--                                      is matched to (set at signup via Llama Vision
--                                      + 1-tap confirm). Filters stock_library on swap.
--   users.primary_selfie_r2_key      → canonical face source for swap, picked from
--                                      the 5-sec liveness video frames at signup.
--   stock_library.appearance_bucket  → which bucket each stock clip belongs to.
--   stock_library.pose_r2_key        → R2 key for the precomputed DWPose pose video.
--   stock_library.mask_r2_key        → R2 key for the precomputed DWPose mask video.
--   generated_pieces.status          → 'processing' | 'ready' | 'failed' lifecycle.
--   generated_pieces.reveal_at       → unix ts when the piece becomes visible (drip).
--   generated_pieces.scenario        → which scenario produced this piece (for dedup).
--
-- Idempotent: column-adds are wrapped to silently no-op if already applied.

-- users ----------------------------------------------------------------------
ALTER TABLE users ADD COLUMN appearance_bucket TEXT;
ALTER TABLE users ADD COLUMN primary_selfie_r2_key TEXT;
CREATE INDEX IF NOT EXISTS idx_users_appearance ON users(appearance_bucket);

-- stock_library --------------------------------------------------------------
ALTER TABLE stock_library ADD COLUMN appearance_bucket TEXT;
ALTER TABLE stock_library ADD COLUMN pose_r2_key TEXT;
ALTER TABLE stock_library ADD COLUMN mask_r2_key TEXT;
CREATE INDEX IF NOT EXISTS idx_stock_scenario_bucket
  ON stock_library(scenario, appearance_bucket, active);

-- generated_pieces -----------------------------------------------------------
ALTER TABLE generated_pieces ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE generated_pieces ADD COLUMN reveal_at INTEGER;
ALTER TABLE generated_pieces ADD COLUMN scenario TEXT;
ALTER TABLE generated_pieces ADD COLUMN stock_library_id TEXT;
CREATE INDEX IF NOT EXISTS idx_pieces_user_reveal
  ON generated_pieces(user_id, reveal_at, status);
CREATE INDEX IF NOT EXISTS idx_pieces_stock
  ON generated_pieces(user_id, stock_library_id);
