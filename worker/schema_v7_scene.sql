-- Mainfeed D1 migration → v7 (scene-accurate stock matching)
-- Run: wrangler d1 execute mainfeed-db --remote --file=worker/schema_v7_scene.sql
--
-- Adds the per-clip SCENE tag so the bake picks the RIGHT scene's stock clip
-- (manifest scene 1-10 → a clip tagged with that scene) instead of any arc+phase
-- clip at random. Scene accuracy = story↔visual match = the moat. pickStock now
-- filters on scene and loosens only the appearance bucket, never the scene.
--
-- Terminology: arc = 30 days · wardrobe_phase = 5 days (1-6) · day = 1-30 · scene = 1-10.
-- Additive ALTER (run once); index uses IF NOT EXISTS.

ALTER TABLE stock_library ADD COLUMN scene INTEGER;   -- 1..10 within a day (NULL = legacy/untagged)

CREATE INDEX IF NOT EXISTS idx_stock_arc_phase_scene
  ON stock_library(arc, wardrobe_phase, scene, appearance_bucket, active);
