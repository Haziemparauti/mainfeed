-- Mainfeed D1 migration → v8: drop the Flux/PuLID image-generation table.
-- Run: wrangler d1 execute mainfeed-db --remote --file=worker/schema_v8_drop_flux.sql
--
-- Mainfeed went video-only on 2026-05-31 (DreamID-V head-swap only; the
-- Flux.1-schnell + PuLID-FLUX image pipeline was removed end-to-end — pod
-- /image endpoint, worker handleAdminImageQueue + pickImageTemplateAndPrompt,
-- and the storytime dispatchPiece image branch). The image_templates table
-- (50 cosplay prompt templates seeded by schema_v5_images.sql) is therefore
-- referenced by NO code and can be dropped. It's static seed data — fully
-- reproducible by re-running schema_v5_images.sql if image gen ever returns.
--
-- NOTE: the now-unused generated_pieces columns image_template_id +
-- generation_prompt are LEFT in place on purpose. SQLite/D1 DROP COLUMN
-- rewrites the entire pieces table — risky on a live table for ~zero benefit.
-- They simply go unwritten. Only the dedicated index + table are removed here.

DROP INDEX IF EXISTS idx_pieces_user_image_template;
DROP TABLE IF EXISTS image_templates;
