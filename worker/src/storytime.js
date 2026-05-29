// Storytime arc orchestration — turns the arc manifest into a user's baked saga.
// See memory: mainfeed_session_2026-05-29_decisions.
//
// Flow:
//   signup → startSaga()  → set users.arc + saga_started_at, enqueue bake_job,
//                            dispatch Day 1 immediately (loading bar resolves)
//   cron   → runBaker()   → dispatch the next un-baked day of the active job
//   pod callback (/api/swap/complete, in index.js) flips pieces processing→ready
//   feed   → getSagaDays()/getDayPieces() → arc → day → clean pieces
//
// Self-contained: no imports from index.js (avoids a circular dep). Uses the
// Workers globals crypto/Date/fetch directly.
//
// INTEGRATION TODOs (validated at the pod/stock session, not now):
//   • stock_library must hold arc clips (arc + wardrobe_phase + bucket) — the
//     Seedance/DWPose library step. Until it does, video/gif dispatch no-ops.
//   • scene-accurate stock matching (manifest scene → stock scenario) is a
//     refinement; v1 picks any arc+phase+bucket clip.
//   • download-branded copy (the watermark bug) is applied on the download
//     path, NOT here — the bake uploads CLEAN media.

import arcManifest from '../../content/arcs/jungle_survival.json';

const DAY_MS = 86_400_000;
const ARC = arcManifest.arc;                 // 'jungle_survival'
const ARC_SHARE = arcManifest.share_name;    // 'LOST'
const API = 'https://api.mainfeed.app';

const uid = () => crypto.randomUUID();
const now = () => Date.now();

// gender is encoded as the bucket prefix ("m_..." / "f_...") — derive it rather
// than rely on the drifted stock_library.gender column.
const genderOf = (bucket, fallback) =>
  (bucket && (bucket[0] === 'm' || bucket[0] === 'f')) ? bucket[0] : (fallback || 'f');

// reveal_at for a given day under the CALENDAR model (simplest; progress-unlock
// is a later one-line swap). All 10 pieces of day N reveal together (batch).
const dayRevealAt = (sagaStartedAt, day) => sagaStartedAt + (day - 1) * DAY_MS;

async function podFetch(url, secret, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
    body: JSON.stringify(payload),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock selection (loose v1: arc + wardrobe_phase + bucket). Returns the row or
// null. Falls back to gender-only (bucket prefix) if no bucket-exact match.
async function pickStock(env, { arc, wardrobePhase, bucket, gender }) {
  let row = null;
  if (bucket) {
    row = await env.DB.prepare(
      `SELECT id, r2_key, pose_r2_key, mask_r2_key FROM stock_library
        WHERE active = 1 AND arc = ? AND wardrobe_phase = ? AND appearance_bucket = ?
        ORDER BY RANDOM() LIMIT 1`
    ).bind(arc, wardrobePhase, bucket).first();
  }
  if (!row) {
    // gender fallback: any arc+phase clip whose bucket starts with the gender
    row = await env.DB.prepare(
      `SELECT id, r2_key, pose_r2_key, mask_r2_key FROM stock_library
        WHERE active = 1 AND arc = ? AND wardrobe_phase = ?
          AND appearance_bucket LIKE ?
        ORDER BY RANDOM() LIMIT 1`
    ).bind(arc, wardrobePhase, `${gender}\\_%`).first().catch(() => null);
  }
  return row;
}

// Public HTTPS URL the pod can fetch for an R2 key under the content/stock buckets.
const stockUrl = (r2Key) => `${API}/public/stock/${String(r2Key).split('/').pop()}`;

// Fill the manifest prompt's {subject} slot from the user's bucket/gender.
function fillPrompt(prompt, { gender, bucket }) {
  const subject = gender === 'm' ? 'a man' : 'a woman';
  return String(prompt || '').replaceAll('{subject}', subject).replaceAll('{bucket_phrase}', subject);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch ONE manifest piece: insert the generated_pieces row (clean media,
// status=processing, with story coords + reveal_at + the in-app caption), then
// fire the pod. video/gif → /swap, image → /image.
async function dispatchPiece(env, user, day, wardrobePhase, piece, revealAt, bakeJobId) {
  const pieceId = uid();
  const ts = now();
  const gender = genderOf(user.appearance_bucket, user.gender);
  const isImage = piece.format === 'image';
  const ext = isImage ? 'jpg' : 'mp4';
  const r2Key = `generated/${pieceId}.${ext}`;
  const type = piece.format; // 'video' | 'gif' | 'image'

  // Pre-insert the row so the callback has a target and the feed can gate by it.
  // caption = the in-app monologue (shown by the app, NEVER burned in).
  await env.DB.prepare(
    `INSERT INTO generated_pieces
       (id, user_id, diary_entry_id, type, caption, r2_key, mime_type,
        generation_provider, created_at, download_count, share_count,
        status, arc, day, scene, wardrobe_phase, reveal_at, bake_job_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 'processing', ?, ?, ?, ?, ?, ?)`
  ).bind(
    pieceId, user.id, type, piece.caption || '', r2Key,
    isImage ? 'image/jpeg' : 'video/mp4',
    isImage ? 'flux-pulid' : 'dreamidv-faster',
    ts, ARC, day, piece.scene, wardrobePhase, revealAt, bakeJobId,
  ).run();

  // Source selfie → temp public copy keyed by pieceId (cleaned on callback).
  const sel = await env.SELFIES.get(user.primary_selfie_r2_key);
  if (!sel) { await markFailed(env, pieceId, 'selfie_missing'); return; }
  const tmpKey = `stock/_src_${pieceId}.jpg`;
  await env.STOCK.put(tmpKey, sel.body, { httpMetadata: { contentType: 'image/jpeg' } });
  const sourceImageUrl = `${API}/public/stock/_src_${pieceId}.jpg`;

  const secret = env.SWAP_POD_SECRET;
  const base = env.SWAP_POD_URL.replace(/\/+$/, '');

  try {
    let res;
    if (isImage) {
      res = await podFetch(`${base}/image`, secret, {
        request_id: pieceId,
        source_image_url: sourceImageUrl,
        prompt: fillPrompt(piece.prompt, { gender, bucket: user.appearance_bucket }),
        callback_url: `${API}/api/swap/complete`,
        output_r2_key: r2Key,
        width: 1024, height: 1024, num_steps: 4,   // Flux.1-schnell turbo, native
        // arc_name/day carried for the download-brand path (bake uploads clean)
        handle: user.handle, arc_name: ARC_SHARE, day,
      });
    } else {
      const stock = await pickStock(env, {
        arc: ARC, wardrobePhase, bucket: user.appearance_bucket, gender,
      });
      if (!stock) { await markFailed(env, pieceId, 'no_stock_for_arc_phase'); return; }
      res = await podFetch(`${base}/swap`, secret, {
        request_id: pieceId,
        source_image_url: sourceImageUrl,
        target_video_url: stockUrl(stock.r2_key),
        // DWPose cache: hand the pod the precomputed pose+mask so it skips the
        // ~30s inline pass (render_overlay/dreamidv_runtime read these).
        target_pose_url: stock.pose_r2_key ? stockUrl(stock.pose_r2_key) : null,
        target_mask_url: stock.mask_r2_key ? stockUrl(stock.mask_r2_key) : null,
        callback_url: `${API}/api/swap/complete`,
        output_r2_key: r2Key,
        sample_steps: 16, sample_guide_scale_img: 4.0,
        // TEST: proven config (832*480, 3s). Square 1024² + 5s (frame_num 120)
        // are unvalidated on this model — validate on the hot pod, then switch.
        size: '832*480',
        frame_num: piece.format === 'gif' ? 37 : 81,
        handle: user.handle, arc_name: ARC_SHARE, day,
      });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      await markFailed(env, pieceId, `pod_${res.status}: ${t.slice(0, 120)}`);
    }
  } catch (err) {
    await markFailed(env, pieceId, `dispatch_error: ${String(err).slice(0, 120)}`);
  }
}

async function markFailed(env, pieceId, reason) {
  console.error('[storytime] piece failed', pieceId, reason);
  await env.DB.prepare(`UPDATE generated_pieces SET status = 'failed' WHERE id = ?`)
    .bind(pieceId).run().catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch every piece of one day (10 pieces). reveal_at = that day's start.
async function dispatchDay(env, user, day) {
  const dayDef = (arcManifest.days || {})[String(day)];
  if (!dayDef) { console.warn('[storytime] no manifest for day', day); return 0; }
  const revealAt = dayRevealAt(user.saga_started_at, day);
  // wardrobe_phase = ceil(day/5) for the 6×5 arc structure.
  const wardrobePhase = Math.ceil(day / 5);
  // Per-day idempotency: skip if this day was already dispatched for the user.
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM generated_pieces WHERE user_id = ? AND arc = ? AND day = ?`
  ).bind(user.id, ARC, day).first();
  if ((existing?.c || 0) > 0) return 0;

  let n = 0;
  for (const piece of dayDef.pieces) {
    await dispatchPiece(env, user, day, wardrobePhase, piece, revealAt, user._bakeJobId || null);
    n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Called from handleSignup. Anchors the saga, enqueues the trial bake, and
// dispatches Day 1 right away so the welcome loading bar resolves in minutes.
export async function startSaga(env, user) {
  const ts = user.saga_started_at || now();
  await env.DB.prepare(`UPDATE users SET arc = ?, saga_started_at = ? WHERE id = ?`)
    .bind(ARC, ts, user.id).run();

  const bakeJobId = uid();
  await env.DB.prepare(
    `INSERT INTO bake_jobs
       (id, user_id, arc, job_type, day_from, day_to, status, priority,
        pieces_total, pieces_completed, pieces_failed, queued_at)
     VALUES (?, ?, ?, 'trial', 1, 7, 'running', 'high', 0, 0, 0, ?)`
  ).bind(bakeJobId, user.id, ARC, ts).run();

  // Dispatch Day 1 immediately (high priority — user is waiting on the bar).
  await dispatchDay(env, { ...user, saga_started_at: ts, _bakeJobId: bakeJobId }, 1);
  return bakeJobId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Called from the scheduled (cron) handler alongside the janitor. Advances the
// active bake job by ONE day per tick (10 pieces) to avoid flooding the pod.
export async function runBaker(env) {
  const job = await env.DB.prepare(
    `SELECT * FROM bake_jobs WHERE status IN ('queued','running')
      ORDER BY (priority='high') DESC, queued_at ASC LIMIT 1`
  ).first();
  if (!job) return;

  const user = await env.DB.prepare(
    `SELECT id, handle, appearance_bucket, primary_selfie_r2_key, arc, saga_started_at
       FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(job.user_id).first();
  if (!user) {
    await env.DB.prepare(`UPDATE bake_jobs SET status='failed' WHERE id=?`).bind(job.id).run();
    return;
  }

  // Find the next day in [day_from, day_to] not yet dispatched.
  for (let day = job.day_from; day <= job.day_to; day++) {
    const has = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM generated_pieces WHERE user_id=? AND arc=? AND day=?`
    ).bind(user.id, job.arc, day).first();
    if ((has?.c || 0) === 0) {
      await dispatchDay(env, { ...user, _bakeJobId: job.id }, day);
      console.log('[storytime] runBaker dispatched day', day, 'for', user.id);
      return; // one day per tick
    }
  }
  // All days dispatched → job done.
  await env.DB.prepare(`UPDATE bake_jobs SET status='completed', completed_at=? WHERE id=?`)
    .bind(now(), job.id).run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed: arc → day list. A day is "open" when its reveal_at has passed AND it has
// ≥1 ready piece. Returns [{day, title, total, ready, open, revealed_at}].
export async function getSagaDays(env, userId) {
  const u = await env.DB.prepare(
    `SELECT arc, saga_started_at FROM users WHERE id = ?`
  ).bind(userId).first();
  if (!u || !u.arc) return { arc: null, days: [] };

  const rows = await env.DB.prepare(
    `SELECT day,
            COUNT(*) AS total,
            SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
            MIN(reveal_at) AS reveal_at
       FROM generated_pieces
      WHERE user_id = ? AND arc = ? AND deleted_at IS NULL
      GROUP BY day ORDER BY day ASC`
  ).bind(userId, u.arc).all();

  const t = now();
  const days = (rows.results || []).map((r) => ({
    day: r.day,
    title: ((arcManifest.days || {})[String(r.day)] || {}).title || `Day ${r.day}`,
    total: r.total,
    ready: r.ready,
    open: r.reveal_at != null && r.reveal_at <= t && r.ready > 0,
    revealed_at: r.reveal_at,
  }));
  return { arc: u.arc, share_name: ARC_SHARE, days };
}

// Feed: one day's pieces (clean media), ordered by scene, only ready + revealed.
export async function getDayPieces(env, userId, day) {
  const t = now();
  const rows = await env.DB.prepare(
    `SELECT id, type, caption, scene, mime_type, width, height, duration, reveal_at
       FROM generated_pieces
      WHERE user_id = ? AND arc = ? AND day = ?
        AND status='ready' AND reveal_at <= ? AND deleted_at IS NULL
      ORDER BY scene ASC`
  ).bind(userId, ARC, day, t).all();

  return (rows.results || []).map((p) => ({
    id: p.id, type: p.type, caption: p.caption, scene: p.scene,
    mime: p.mime_type, width: p.width, height: p.height, duration: p.duration,
    file_url: `/api/piece/${p.id}/file`,   // CLEAN media (bug only on ?download=1)
  }));
}
