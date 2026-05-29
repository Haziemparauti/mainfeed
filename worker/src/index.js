// Mainfeed API worker — v0 backend
// Endpoints: signup, login, logout, me, feed, diary, piece file, piece delete

import { startSaga, runBaker, getSagaDays, getDayPieces, dispatchDay } from './storytime.js';

const ALLOWED_ORIGINS = new Set([
  'https://mainfeed.app',
  'https://www.mainfeed.app',
  'https://mainfeed.pages.dev',
  'http://localhost:8788',
  'http://localhost:8787',
]);

const RESERVED_HANDLES = new Set([
  'admin', 'api', 'app', 'help', 'about', 'login', 'signup',
  'logout', 'me', 'settings', 'profile', 'terms', 'privacy',
  'mainfeed', 'feed', 'home', 'support', 'contact',
  'assets', 'static', 'www', 'public', 'private', 'system',
]);

// Testing-phase signup cap. Bump up when monetization is wired + abuse signals are in place.
const MAX_USERS = 5;

// ============ Utilities ============

function cors(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://mainfeed.app';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, init = {}, origin = '') {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(cors(origin))) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

function errResp(code, status, origin, extra = {}) {
  return json({ error: code, ...extra }, { status }, origin);
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function uid() {
  return crypto.randomUUID();
}

function hex(buf) {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function sessionToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

// ============ Password hashing (PBKDF2-SHA256) ============

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key, 256
  );
  return `pbkdf2$${iterations}$${hex(salt)}$${hex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!iterations || iterations < 10000) return false;
  const salt = unhex(parts[2]);
  const expected = unhex(parts[3]);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key, expected.length * 8
  );
  return constantTimeEqual(new Uint8Array(bits), expected);
}

// ============ Sessions ============

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function createSession(env, userId) {
  const token = sessionToken();
  const ts = now();
  const expires = ts + SESSION_TTL_SECONDS;
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, userId, ts, expires).run();
  return { token, expires };
}

async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

async function lookupSession(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.token, s.user_id, s.expires_at, u.handle, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.deleted_at IS NULL`
  ).bind(token, now()).first();
  return row || null;
}

function tokenFromRequest(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)mf_session=([A-Za-z0-9]+)/);
  if (m) return m[1];
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function sessionCookie(token, expiresUnix) {
  const maxAge = Math.max(0, expiresUnix - now());
  return `mf_session=${token}; Domain=.mainfeed.app; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookieHeader() {
  return `mf_session=; Domain=.mainfeed.app; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// ============ Validation ============

function isHandle(h) {
  return typeof h === 'string' && /^[a-z0-9]{2,20}$/.test(h);
}

function isEmail(e) {
  return typeof e === 'string' && e.length < 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function isPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length < 256;
}

function isImageMime(m) {
  return typeof m === 'string' && /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(m);
}

// ============ Rate limiting (D1-backed) ============

async function rateLimit(env, key, limit, windowSec) {
  const ts = now();
  const windowStart = ts - (ts % windowSec);
  const row = await env.DB.prepare(
    'SELECT count, window_start FROM rate_limits WHERE key = ?'
  ).bind(key).first();
  if (!row || row.window_start < windowStart) {
    await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`
    ).bind(key, windowStart).run();
    return { allowed: true, remaining: limit - 1 };
  }
  if (row.count >= limit) {
    return { allowed: false, remaining: 0 };
  }
  await env.DB.prepare(
    'UPDATE rate_limits SET count = count + 1 WHERE key = ?'
  ).bind(key).run();
  return { allowed: true, remaining: limit - row.count - 1 };
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// ============ Auth handlers ============

async function handleSignup(request, env, origin) {
  // Rate limit by IP
  const rl = await rateLimit(env, `signup:${clientIp(request)}`, 5, 600);
  if (!rl.allowed) return errResp('rate_limited', 429, origin);

  // Total-user cap during testing phase
  const capRow = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL'
  ).first();
  if ((capRow?.count || 0) >= MAX_USERS) {
    return errResp('user_cap_reached', 403, origin, { cap: MAX_USERS });
  }

  const ct = request.headers.get('Content-Type') || '';
  if (!ct.startsWith('multipart/form-data')) {
    return errResp('expected_multipart', 400, origin);
  }

  const form = await request.formData();
  const handle = String(form.get('handle') || '').toLowerCase().trim();
  const email = String(form.get('email') || '').toLowerCase().trim();
  const password = String(form.get('password') || '');
  const gender = String(form.get('gender') || '').toLowerCase().trim();  // 'm' | 'f'
  const consentAge = form.get('consent_age') === 'true';
  const consentTerms = form.get('consent_terms') === 'true';
  // Profile (onboarding answers) is now OPTIONAL — locked decision per
  // feedback_signup_simple_and_embrace_mismatch: drop the 10-question profile,
  // signup only needs handle/email/password/gender/selfie/age/ToS.
  let profile = {};
  try {
    const raw = form.get('profile');
    if (raw) profile = JSON.parse(String(raw)) || {};
  } catch (e) {
    profile = {};
  }

  if (!isHandle(handle)) return errResp('invalid_handle', 400, origin);
  if (RESERVED_HANDLES.has(handle)) return errResp('reserved_handle', 400, origin);
  if (!isEmail(email)) return errResp('invalid_email', 400, origin);
  if (!isPassword(password)) return errResp('weak_password', 400, origin);
  if (gender !== 'm' && gender !== 'f') return errResp('invalid_gender', 400, origin, { hint: 'gender must be "m" or "f"' });
  if (!consentAge || !consentTerms) return errResp('consent_required', 400, origin);

  // Collect selfies — accept 1–10 (more is better for face-swap source quality).
  const selfies = [];
  for (let i = 0; i < 10; i++) {
    const f = form.get(`selfie_${i}`);
    if (f && typeof f.arrayBuffer === 'function') selfies.push(f);
  }
  if (selfies.length < 1) return errResp('need_at_least_one_selfie', 400, origin);

  // Validate file types + sizes
  const MAX_SELFIE_BYTES = 8 * 1024 * 1024; // 8MB per selfie
  for (const s of selfies) {
    if (!isImageMime(s.type)) return errResp('invalid_image_type', 400, origin);
    if (s.size > MAX_SELFIE_BYTES) return errResp('selfie_too_large', 400, origin);
  }

  // Uniqueness
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE handle = ? OR email = ?'
  ).bind(handle, email).first();
  if (existing) return errResp('handle_or_email_taken', 409, origin);

  // Hash + create
  const passwordHash = await hashPassword(password);
  const userId = uid();
  const ts = now();

  // First selfie is the primary face source for swaps + bucket detection
  const primarySelfieKey = `selfies/${userId}/0.${(selfies[0].type.split('/')[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg')}`;

  // Stash gender + bucket inside the profile JSON too (for legacy callers that read profile)
  const profileJson = JSON.stringify({ onboarding: profile, gender, checkins: [] });

  // ORDER MATTERS (audit 2026-05-26 H4): upload selfies to R2 BEFORE
  // INSERTing the user row. If R2 fails partway, no user row is created so
  // there's no ghost user with no selfies. If INSERT then fails on the
  // UNIQUE constraint race, we clean up the uploaded selfies.
  const uploadedKeys = [];
  try {
    for (let i = 0; i < selfies.length; i++) {
      const s = selfies[i];
      const ext = (s.type.split('/')[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
      const key = `selfies/${userId}/${i}.${ext}`;
      await env.SELFIES.put(key, s.stream(), {
        httpMetadata: { contentType: s.type },
      });
      uploadedKeys.push(key);
    }
  } catch (uploadErr) {
    // Clean up any partial uploads — no orphan files in R2.
    for (const k of uploadedKeys) { try { await env.SELFIES.delete(k); } catch (_) {} }
    console.error('signup: selfie upload failed', uploadErr);
    return errResp('selfie_upload_failed', 502, origin);
  }

  // Now INSERT the user row. If a concurrent signup grabbed the same handle
  // or email between the SELECT above and here, the UNIQUE constraint trips
  // a D1 error — catch, clean up selfies, return a clean 409.
  try {
    await env.DB.prepare(
      `INSERT INTO users
         (id, handle, email, password_hash, created_at,
          liveness_verified, consent_18, consent_ai, consent_terms,
          selfies_count, plan, daily_pieces_count, daily_pieces_reset_at, profile,
          primary_selfie_r2_key)
       VALUES (?, ?, ?, ?, ?, 0, 1, 1, 1, ?, 'free', 0, ?, ?, ?)`
    ).bind(userId, handle, email, passwordHash, ts, selfies.length, ts, profileJson, primarySelfieKey).run();
  } catch (dbErr) {
    // UNIQUE race — clean up the R2 selfies we just uploaded.
    for (const k of uploadedKeys) { try { await env.SELFIES.delete(k); } catch (_) {} }
    const msg = String(dbErr).toLowerCase();
    if (msg.includes('unique') || msg.includes('constraint')) {
      return errResp('handle_or_email_taken', 409, origin);
    }
    console.error('signup: user INSERT failed', dbErr);
    return errResp('signup_failed', 500, origin);
  }

  // Optional 5-second liveness video (per [[feedback_signup_simple_and_embrace_mismatch]]).
  // Stored at mainfeed-selfies/<userId>/liveness.<ext>. Setting liveness_verified=1 is
  // optimistic for MVP — frame-variance check + CSAM-style content scan come later.
  const livenessVideo = form.get('liveness_video');
  if (livenessVideo && typeof livenessVideo.arrayBuffer === 'function' && livenessVideo.size > 0) {
    const MAX_VIDEO_BYTES = 32 * 1024 * 1024;  // 32 MB cap for a 5s phone-camera clip
    if (livenessVideo.size > MAX_VIDEO_BYTES) return errResp('liveness_video_too_large', 400, origin);
    const vMime = livenessVideo.type || 'video/mp4';
    const vExt = vMime.includes('quicktime') || vMime.includes('mov') ? 'mov'
               : vMime.includes('webm') ? 'webm' : 'mp4';
    const vKey = `selfies/${userId}/liveness.${vExt}`;
    await env.SELFIES.put(vKey, livenessVideo.stream(), {
      httpMetadata: { contentType: vMime },
    });
    await env.DB.prepare(
      'UPDATE users SET liveness_verified = 1, liveness_verified_at = ? WHERE id = ?'
    ).bind(now(), userId).run();
  }

  const session = await createSession(env, userId);

  // Appearance-bucket detection (Llama Vision). Best-effort — don't fail
  // signup if Llama flakes. Retry once, then fall back to a sensible
  // gender-keyed default so the welcome swap can still pick a bucket-
  // matched stock clip instead of a random gender-only clip.
  // Audit 2026-05-26 (3rd "known unfixed").
  let appearanceBucket = null;
  for (let attempt = 0; attempt < 2 && !appearanceBucket; attempt++) {
    try {
      const det = await detectAppearanceFromR2(env, primarySelfieKey, 'SELFIES', gender);
      if (det && det.bucket) appearanceBucket = det.bucket;
    } catch (err) {
      console.error(`appearance-detect attempt ${attempt + 1} failed`, err);
    }
  }
  if (!appearanceBucket) {
    // Sensible mid-population default per gender — better than null which
    // would force fall-through to random gender-only clip selection.
    appearanceBucket = gender === 'f'
      ? 'f_long_brown_wavy_fair'
      : 'm_short_dark_straight_brown';
    console.warn('appearance-detect: using gender default', { userId, gender, fallback: appearanceBucket });
  }
  try {
    await env.DB.prepare('UPDATE users SET appearance_bucket = ? WHERE id = ?')
      .bind(appearanceBucket, userId).run();
  } catch (err) {
    console.error('appearance-bucket update failed', err);
  }

  // Storytime: anchor the saga, enqueue the trial bake, and dispatch Day 1
  // immediately so the loading bar resolves in minutes (replaces the old single
  // welcome-video swap). The pod callbacks flip each piece processing→ready.
  // See worker/src/storytime.js.
  try {
    await startSaga(env, {
      id: userId,
      handle,
      gender,
      appearance_bucket: appearanceBucket,
      primary_selfie_r2_key: primarySelfieKey,
      saga_started_at: ts,
    });
  } catch (err) {
    console.error('startSaga failed', err);
  }

  return json(
    { ok: true, user: { id: userId, handle, email } },
    { headers: { 'Set-Cookie': sessionCookie(session.token, session.expires) } },
    origin
  );
}

async function handleLogin(request, env, origin) {
  const rl = await rateLimit(env, `login:${clientIp(request)}`, 10, 60);
  if (!rl.allowed) return errResp('rate_limited', 429, origin);

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '').toLowerCase().trim();
  const password = String(body.password || '');

  if (!id || !password) return errResp('missing_fields', 400, origin);

  // Dual lookup (handle OR email)
  const user = await env.DB.prepare(
    `SELECT id, handle, email, password_hash
     FROM users WHERE (handle = ? OR email = ?) AND deleted_at IS NULL`
  ).bind(id, id).first();
  if (!user) return errResp('invalid_credentials', 401, origin);

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return errResp('invalid_credentials', 401, origin);

  const session = await createSession(env, user.id);

  return json(
    { ok: true, user: { id: user.id, handle: user.handle, email: user.email } },
    { headers: { 'Set-Cookie': sessionCookie(session.token, session.expires) } },
    origin
  );
}

async function handleLogout(request, env, origin) {
  const token = tokenFromRequest(request);
  await destroySession(env, token);
  return json(
    { ok: true },
    { headers: { 'Set-Cookie': clearSessionCookieHeader() } },
    origin
  );
}

async function requireSession(request, env, origin) {
  const session = await lookupSession(env, tokenFromRequest(request));
  if (!session) {
    return { error: errResp('not_authenticated', 401, origin) };
  }
  return { session };
}

async function handleMe(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;
  const u = await env.DB.prepare(
    'SELECT liveness_verified FROM users WHERE id = ?'
  ).bind(r.session.user_id).first();
  return json(
    {
      ok: true,
      user: {
        id: r.session.user_id,
        handle: r.session.handle,
        email: r.session.email,
        verified: !!(u && u.liveness_verified),
      },
    },
    {}, origin
  );
}

// Liveness verification is no longer required at signup. It's required only
// when the user tries to publish a piece to their public /@handle page —
// see [[mainfeed_app_project]]. The 10-sec record + face-check flow is
// reused on the client; this endpoint just stores the video and flips the
// liveness_verified flag.
async function handleVerifyIdentity(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const rl = await rateLimit(env, `verify:${r.session.user_id}`, 5, 600);
  if (!rl.allowed) return errResp('rate_limited', 429, origin);

  const ct = request.headers.get('Content-Type') || '';
  if (!ct.startsWith('multipart/form-data')) {
    return errResp('expected_multipart', 400, origin);
  }

  const form = await request.formData();
  const video = form.get('liveness_video');
  if (!video || typeof video.arrayBuffer !== 'function' || video.size === 0) {
    return errResp('liveness_video_required', 400, origin);
  }

  const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
  if (video.size > MAX_VIDEO_BYTES) return errResp('liveness_video_too_large', 400, origin);

  const userId = r.session.user_id;
  const vMime = video.type || 'video/mp4';
  const vExt = vMime.includes('quicktime') || vMime.includes('mov') ? 'mov'
             : vMime.includes('webm') ? 'webm' : 'mp4';
  const vKey = `selfies/${userId}/liveness.${vExt}`;
  await env.SELFIES.put(vKey, video.stream(), {
    httpMetadata: { contentType: vMime },
  });

  const ts = now();
  await env.DB.prepare(
    'UPDATE users SET liveness_verified = 1, liveness_verified_at = ? WHERE id = ?'
  ).bind(ts, userId).run();

  return json({ ok: true, verified: true, verified_at: ts }, {}, origin);
}

// ============ Feed / Pieces ============

// POST to the pod's /swap endpoint with retry-on-5xx/404/network-error.
// Retries with exponential backoff (1s, 4s) to absorb transient
// Cloudflare-edge / RunPod-proxy flakes. Audit 2026-05-26 evening — we saw
// a 404 from the proxy on a healthy pod once. Returns the final Response
// object (or throws if every attempt errored).
async function fetchPodWithRetry(url, init, {
  maxAttempts = 3,
  retryStatuses = [404, 500, 502, 503, 504],
  backoffMs = [1000, 4000],
} = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      // 2xx + 3xx → success. 4xx (other than 404) → real client error, don't retry.
      // 5xx + 404 → transient infra flake, retry.
      if (!retryStatuses.includes(res.status)) return res;
      // Drain body so the connection can be reused.
      try { await res.text(); } catch (_) {}
      if (attempt >= maxAttempts) return res;  // out of attempts; return the last bad response
      const wait = backoffMs[attempt - 1] || backoffMs[backoffMs.length - 1];
      console.warn(`[fetchPodWithRetry] ${url} attempt ${attempt} → ${res.status}, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) throw err;
      const wait = backoffMs[attempt - 1] || backoffMs[backoffMs.length - 1];
      console.warn(`[fetchPodWithRetry] ${url} attempt ${attempt} threw ${String(err).slice(0, 80)}, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error('fetchPodWithRetry exhausted attempts');
}


// Auto-retry the welcome video swap when the user opens the app and has
// no pieces to show yet. Catches the case where signup-time pod call hit
// some failure mode the retry logic couldn't absorb, leaving the user with
// no welcome content. Idempotent: only fires if 0 ready + 0 processing
// pieces AND user is < 24h old (so we don't keep re-queueing forever).
//
// Called via ctx.waitUntil from handleFeed — doesn't block the feed response.
async function maybeRetryWelcomeOnFeedOpen(env, userId) {
  const userRow = await env.DB.prepare(
    `SELECT id, handle, profile, primary_selfie_r2_key, appearance_bucket, created_at
       FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(userId).first();
  if (!userRow) return;

  // Only auto-retry within the first 24h after signup.
  const HOUR = 3600 * 1000;
  const ageMs = Date.now() - (userRow.created_at || 0);
  if (ageMs > 24 * HOUR) return;

  // Skip if the user already has a ready piece OR a processing one in flight.
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready_count,
       SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) AS processing_count,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_count
     FROM generated_pieces
     WHERE user_id = ? AND deleted_at IS NULL`
  ).bind(userId).first();
  const ready = Number(counts?.ready_count || 0);
  const processing = Number(counts?.processing_count || 0);
  if (ready > 0 || processing > 0) return;

  // Pull gender from profile JSON (signup writes { onboarding, gender, checkins } there).
  let gender = 'm';
  try {
    const p = JSON.parse(userRow.profile || '{}');
    if (p.gender === 'f' || p.gender === 'm') gender = p.gender;
  } catch (_) {}

  console.log('[welcome-retry-on-feed-open] firing for', userId, {
    ready, processing, failed: counts?.failed_count || 0, ageMin: Math.floor(ageMs / 60000),
  });
  await generateWelcomeVideoSwap(
    env, userRow.id, userRow.handle, gender,
    userRow.primary_selfie_r2_key, userRow.appearance_bucket, Date.now(),
  );
}


async function handleFeed(request, env, ctx, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

  // Only surface READY pieces — processing rows are a backend detail; failed
  // rows are noise (we retry on the user's next diary entry). Per user
  // 2026-05-26: "ONLY WHEN THE VIDEO IS DONE, IT GETS PUSHED AND THE USER
  // SEES THE NEW CONTENT". No placeholders, no error messages, no captions
  // surfaced ahead of the render.
  const rows = await env.DB.prepare(
    `SELECT id, type, caption, mime_type, width, height, duration, created_at, public, status
     FROM generated_pieces
     WHERE user_id = ? AND deleted_at IS NULL AND status = 'ready'
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(r.session.user_id, limit, offset).all();

  const pieces = (rows.results || []).map((p) => ({
    id: p.id,
    type: p.type,
    caption: p.caption,
    mime: p.mime_type,
    width: p.width,
    height: p.height,
    duration: p.duration,
    created_at: p.created_at,
    file_url: `/api/piece/${p.id}/file`,
    public: !!p.public,
    status: p.status || 'ready',
  }));

  // (Storytime) The old welcome-retry self-heal is disabled — content now comes
  // from the pre-bake queue (startSaga + runBaker), not a single welcome swap.
  // The Storytime feed uses /api/saga/days + /api/saga/day (handleFeed is legacy).

  return json({ ok: true, pieces, total: pieces.length }, {}, origin);
}

// ===== Storytime feed (arc → day → pieces) =====

async function handleSagaDays(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;
  const data = await getSagaDays(env, r.session.user_id);
  return json({ ok: true, ...data }, {}, origin);
}

async function handleSagaDay(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;
  const day = parseInt(new URL(request.url).searchParams.get('n') || '0', 10);
  if (!day) return errResp('missing_day', 400, origin);
  const pieces = await getDayPieces(env, r.session.user_id, day);
  return json({ ok: true, day, pieces }, {}, origin);
}

// Admin: re-dispatch one day for a user (wipes that day's pieces first), so we
// can re-run a day's bake without a fresh signup. For test iteration. ADMIN_TOKEN.
async function handleAdminRebakeDay(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);
  const body = await request.json().catch(() => ({}));
  const handle = String(body.handle || '').toLowerCase().trim();
  const day = parseInt(body.day || 0, 10);
  if (!handle || !day) return errResp('missing_fields', 400, origin);
  const u = await env.DB.prepare(
    'SELECT id, handle, appearance_bucket, primary_selfie_r2_key, arc, saga_started_at FROM users WHERE handle = ? AND deleted_at IS NULL'
  ).bind(handle).first();
  if (!u) return errResp('user_not_found', 404, origin);
  await env.DB.prepare('DELETE FROM generated_pieces WHERE user_id = ? AND arc = ? AND day = ?')
    .bind(u.id, u.arc, day).run();
  await dispatchDay(env, { ...u }, day);
  return json({ ok: true, handle, day, redispatched: true }, {}, origin);
}

async function handlePieceFile(request, env, origin, pieceId) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const piece = await env.DB.prepare(
    'SELECT user_id, r2_key, mime_type FROM generated_pieces WHERE id = ? AND deleted_at IS NULL'
  ).bind(pieceId).first();
  if (!piece) return errResp('not_found', 404, origin);
  if (piece.user_id !== r.session.user_id) return errResp('forbidden', 403, origin);

  const obj = await env.CONTENT.get(piece.r2_key);
  if (!obj) return errResp('file_missing', 404, origin);

  const url = new URL(request.url);
  const wantDownload = url.searchParams.get('download') === '1';
  const ext = (piece.mime_type || 'image/jpeg').split('/')[1] || 'jpg';
  const headers = {
    'Content-Type': piece.mime_type || 'application/octet-stream',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...cors(origin),
  };
  if (wantDownload) {
    headers['Content-Disposition'] = `attachment; filename="mainfeed-${pieceId}.${ext}"`;
  }
  return new Response(obj.body, { headers });
}

async function handlePieceDelete(request, env, origin, pieceId) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const piece = await env.DB.prepare(
    'SELECT user_id FROM generated_pieces WHERE id = ? AND deleted_at IS NULL'
  ).bind(pieceId).first();
  if (!piece) return errResp('not_found', 404, origin);
  if (piece.user_id !== r.session.user_id) return errResp('forbidden', 403, origin);

  await env.DB.prepare(
    'UPDATE generated_pieces SET deleted_at = ? WHERE id = ?'
  ).bind(now(), pieceId).run();

  return json({ ok: true }, {}, origin);
}

// Toggle public flag on a piece (owner only)
async function handlePiecePublish(request, env, origin, pieceId, value) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const piece = await env.DB.prepare(
    'SELECT user_id FROM generated_pieces WHERE id = ? AND deleted_at IS NULL'
  ).bind(pieceId).first();
  if (!piece) return errResp('not_found', 404, origin);
  if (piece.user_id !== r.session.user_id) return errResp('forbidden', 403, origin);

  // Going PUBLIC requires liveness verification (legal: likeness consent +
  // anti-impersonation). Unpublishing is always allowed.
  if (value) {
    const u = await env.DB.prepare(
      'SELECT liveness_verified FROM users WHERE id = ?'
    ).bind(r.session.user_id).first();
    if (!u || !u.liveness_verified) {
      return errResp('verification_required', 403, origin);
    }
  }

  await env.DB.prepare(
    'UPDATE generated_pieces SET public = ? WHERE id = ?'
  ).bind(value ? 1 : 0, pieceId).run();

  return json({ ok: true, public: value ? 1 : 0 }, {}, origin);
}

// Public profile — no auth, returns user's public pieces only
async function handlePublicProfile(request, env, origin, handle) {
  const h = String(handle || '').toLowerCase().trim();
  if (!isHandle(h)) return errResp('invalid_handle', 400, origin);

  const user = await env.DB.prepare(
    'SELECT id, handle FROM users WHERE handle = ? AND deleted_at IS NULL'
  ).bind(h).first();
  if (!user) return errResp('not_found', 404, origin);

  const rows = await env.DB.prepare(
    `SELECT id, type, caption, mime_type, width, height, created_at
     FROM generated_pieces
     WHERE user_id = ? AND deleted_at IS NULL AND public = 1
     ORDER BY created_at DESC LIMIT 50`
  ).bind(user.id).all();

  const pieces = (rows.results || []).map((p) => ({
    id: p.id,
    type: p.type,
    caption: p.caption,
    mime: p.mime_type,
    width: p.width,
    height: p.height,
    created_at: p.created_at,
    file_url: `/api/piece/${p.id}/public-file`,
  }));

  return json({ ok: true, user: { handle: user.handle }, pieces }, {}, origin);
}

// Public file serving — no auth, only if piece is published
async function handlePublicPieceFile(request, env, origin, pieceId) {
  const piece = await env.DB.prepare(
    'SELECT r2_key, mime_type, public FROM generated_pieces WHERE id = ? AND deleted_at IS NULL'
  ).bind(pieceId).first();
  if (!piece || !piece.public) return errResp('not_found', 404, origin);

  const obj = await env.CONTENT.get(piece.r2_key);
  if (!obj) return errResp('file_missing', 404, origin);

  return new Response(obj.body, {
    headers: {
      'Content-Type': piece.mime_type || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      ...cors(origin),
    }
  });
}

// ============ Generation pipeline (Workers AI: Llama 3.1 + Flux Schnell) ============

// Caption-writing few-shot prompt — irony/contrast meme voice (Gen-Z TikTok/X)
const CAPTION_SYSTEM_PROMPT = `You write meme captions for a personal AI feed. The user's handle is @{handle}. They just shared something about their day. Write ONE caption in the VIRAL IRONY/CONTRAST style — the caption sets up an expectation and the IMAGE will show the opposite/truth.

Caption FORMATS (pick whichever fits, sometimes mix):
- "POV: [setup that ignores reality]"
- "[Quote pretending to be authority]" / "Me [doing the opposite]:"
- "How I think I [verb] / How I actually [verb]"
- "Me [action] knowing [contradicting fact]"
- "[Friends/society/expectation] / Me:"
- "When [common situation]"

Rules:
- 4-25 words total, 1 or 2 short lines max
- Use " / " to split into top/bottom when there are two parts (setup vs reality)
- No emojis, no hashtags, no surrounding quotes
- Self-aware, ironic, slightly chaotic, sound like a 22-year-old shitposter
- Reference the user's content specifically — name dropping @{handle} is OPTIONAL not required
- ALL LOWERCASE preferred for casual energy, but proper nouns + POV/Me can stay capitalized

Examples (study the pattern):
diary: "just woke up at 4pm" -> POV: you woke up at 4pm and act like its normal
diary: "had school today and it was bad" -> POV: just finished school today acting happy all day
diary: "trying to sleep but i'm wired" -> "Science says the best time to sleep is during night" / Me at 3am:
diary: "my friend asked if im okay" -> My friends asking if I'm okay / Me lying to them in 4K:
diary: "going to bed early" -> "You're going to bed early tonight" / Me at 3am:
diary: "monday energy is rough" -> POV: it's Monday and you're already done
diary: "gym day" -> How I think I look at the gym / how I actually look
diary: "i overate" -> Me promising myself i'd eat healthy / Me 30 minutes later:
diary: "another zoom call" -> Hour 3 of a 30 min meeting and im not gonna make it
diary: "checking my bank account" -> Me checking my bank app for the 47th time today
diary: "missed the meeting" -> Me realising the meeting started 10 minutes ago
diary: "the wifi just died" -> Wifi disconnecting 1 minute before save
diary: "rejected by crush" -> Me convincing myself they're missing out (they're not)
diary: "i did one productive thing" -> Me after replying to ONE email expecting a parade
diary: "exam tomorrow" -> Tomorrow's exam at 8am / Me starting to study at 11pm
diary: "fast food again" -> Me promising "this is the last time" for the 5th week in a row
diary: "got dressed up for nothing" -> POV: dressing up for an event no one invited you to
diary: "i miss home" -> Me being totally fine on my own / Me at 9pm calling mom:
diary: "i ate the chocolate again" -> The chocolate i hid from myself: / Me 30 minutes later:
diary: "lost at the game" -> POV: you got dragged in your own ranked game by a 12yo
diary: "spilled coffee on my shirt" -> Me trying to start the day strong / The coffee 30 seconds later:
diary: "boss said we need to talk" -> Receiving "we need to talk" at 11pm / Me trying to act normal:
diary: "told everyone im starting the gym" -> Me telling everyone I'm starting the gym tomorrow / Tomorrow's me:
diary: "made it through monday" -> POV: surviving Monday and immediately needing to recover
diary: "tried to study" -> Me opening the textbook with full focus / Me 8 minutes later on TikTok:

Output ONLY the caption text. No quotes around it, no explanation, no prefix.`;

// Image-prompt rewriter — extract the IRONIC visual (the "truth" half of the meme)
const IMAGE_PROMPT_SYSTEM = `You turn a meme caption into a visual prompt for an AI image generator (Flux). The caption uses the IRONY/CONTRAST pattern — your job is to extract the TRUE/IRONIC visual (the reality being shown), NOT the setup.

Rules:
- 10-30 words
- Describe the SCENE matching the IRONY/CONTRADICTION
- One person doing the action, vivid setting, cinematic lighting, film-still aesthetic
- No text/letters/logos in the image, no real celebrities or named people
- Use "young person" or "young adult" — don't specify gender unless the caption requires it

Examples (study which part of the caption becomes the visual):
caption: "POV: you woke up at 4pm and act like its normal" -> young person sprawled in messy bed, golden sunset light through closed blinds, exhausted dazed expression, clock visible reading late afternoon, cinematic
caption: "Science says the best time to sleep is during night / Me at 3am:" -> young person sleeping diagonally on bed, harsh midday sun blasting through window, twisted blanket, dead asleep mouth open, cinematic
caption: "POV: just finished school today acting happy all day" -> young person in parked car gripping steering wheel, face contorted mid-yell, parking lot setting, dramatic afternoon light through windshield
caption: "Me checking my bank app for the 47th time today" -> young person on couch holding phone close, illuminated by screen glow in dim room, defeated worried expression, soft evening light
caption: "How I think I look at the gym / how I actually look" -> young person at gym mid-exercise, sweaty disheveled hair, slightly off-balance, fluorescent gym lighting, candid not posed
caption: "Hour 3 of a 30 min meeting and im not gonna make it" -> young person at desk in front of laptop, head propped on hand, eyes glazed over, late afternoon sunlight, zoom call visible on screen
caption: "Wifi disconnecting 1 minute before save" -> young person at desk staring at monitor in horror, hands frozen over keyboard, dark room lit only by screen, expression of pure betrayal
caption: "POV: dressing up for an event no one invited you to" -> young person in formal outfit standing alone in living room, phone in hand checking, soft golden hour light, slight melancholy
caption: "POV: surviving Monday and immediately needing to recover" -> young person collapsed face-down on couch in work clothes, one shoe still on, evening light, completely done

Output ONLY the visual description. No quotes, no preamble.`;

// Welcome scenarios — every new user gets one of these randomly (30 variants)
const WELCOME_SCENARIOS = [
  { caption: 'POV: you already regret signing up for your own main character feed', prompt: 'young person in dim bedroom holding phone, illuminated by phone screen glow, slightly worried slightly intrigued expression, soft evening light, cinematic candid' },
  { caption: 'POV: you just signed up and already worried what the AI is gonna say', prompt: 'young person looking at phone with raised eyebrows, slight concerned smile, soft indoor light, candid film still' },
  { caption: 'POV: stepping into your main character arc you didn\'t ask for', prompt: 'young person standing in dramatic doorway with confident walking pose, golden hour light streaming in behind, cinematic film still' },
  { caption: 'POV: realising the AI knows you better than you do', prompt: 'young person staring wide-eyed at phone screen in dim bedroom, blue screen glow on face, slight panic, dramatic film still' },
  { caption: 'me explaining to my friends why i made a mainfeed:', prompt: 'young person mid-conversation gesturing with hands, slightly defensive smile, cozy cafe or living room setting, warm natural lighting' },
  { caption: 'when the app you just signed up for already starts roasting you', prompt: 'young person looking at phone mouth slightly open in disbelief, slight smile, soft indoor lighting, candid' },
  { caption: 'POV: signed up for the app where i am the only protagonist', prompt: 'young person walking confidently with phone in hand, blurred soft background, cinematic depth of field, golden hour light' },
  { caption: 'first day on mainfeed energy', prompt: 'young person leaning back on couch with phone, content small smile, cozy living room with warm evening light' },
  { caption: 'POV: about to find out what the AI thinks of you', prompt: 'young person staring intently at phone, slight nervous smile, late afternoon golden light through window, candid' },
  { caption: 'POV: trapped on an app that only generates content about me', prompt: 'young person on bed surrounded by pillows, phone held close to face, slight dazed amused expression, warm bedroom lighting' },
  { caption: 'POV: 5 minutes into mainfeed and already addicted', prompt: 'young person glued to phone in dim room, slight grin, phone glow on face, late evening light, cinematic candid' },
  { caption: 'me showing up to my new ai-generated era:', prompt: 'young person walking through a sunlit doorway with confident smirk, golden hour backlight, cinematic film still' },
  { caption: 'when you realize the app will keep making content about you forever', prompt: 'young person staring at phone with wide eyes slight smile, soft indoor lighting, candid film still' },
  { caption: 'POV: about to become the main character of your own feed', prompt: 'young person standing in quiet living room holding phone, slight knowing smile, soft morning light, cinematic' },
  { caption: 'POV: just made a mainfeed and feeling like a small celebrity', prompt: 'young person leaning back on couch with smug satisfied expression, cozy room warm lighting, slight smirk' },
  { caption: 'me telling myself "i\'ll only check it once" today:', prompt: 'young person on phone in bed with dim ambient room, phone glow on face, conflicted slight smile, candid' },
  { caption: 'when the AI starts generating content of you and you\'re not ready', prompt: 'young person looking at phone with hand half-covering mouth in surprise, soft bedroom lighting, candid' },
  { caption: 'POV: signed up to a feed that\'s gonna roast me daily', prompt: 'young person on couch with phone, slight nervous laugh, warm indoor light, candid film still' },
  { caption: 'POV: the mainfeed era has begun', prompt: 'young person looking out window holding phone, dramatic side light, slight introspective expression' },
  { caption: 'me already planning what to share from this app:', prompt: 'young person on couch scrolling phone with thoughtful slight smile, cozy evening lighting' },
  { caption: 'POV: finally an algorithm that\'s all about ME', prompt: 'young person mid-laugh holding phone close to face, soft natural light, candid joyful moment' },
  { caption: 'when you join an app and immediately know it was a mistake (good kind):', prompt: 'young person sitting on bed mid-laugh holding phone, surprised amused expression, warm bedroom light' },
  { caption: 'POV: i am the protagonist now', prompt: 'young person walking through golden-hour street holding phone, confident slight smile, blurred background, cinematic' },
  { caption: 'me explaining mainfeed to my friend group chat:', prompt: 'young person mid-text on phone with focused slight smile, cozy room lighting, candid' },
  { caption: 'POV: the AI made one piece and i\'m already attached', prompt: 'young person on couch holding phone with attached fond expression, soft evening light' },
  { caption: 'when your face becomes the algorithm\'s whole personality:', prompt: 'young person looking at phone with slight amused disbelief, soft bedroom light, candid' },
  { caption: 'POV: feeding the AI just enough info to be dangerous', prompt: 'young person leaning over phone with mischievous smile, dim ambient lighting, dramatic film still' },
  { caption: 'me waiting for my AI to drop content about me like:', prompt: 'young person cross-legged on bed staring at phone with anticipation, warm bedroom light, candid' },
  { caption: 'POV: the only social media where everyone is muted except me', prompt: 'young person in cozy chair with phone, content peaceful expression, soft natural light, cinematic' },
  { caption: 'signing up for mainfeed energy:', prompt: 'young person mid-stride entering room holding phone, slight confident smile, golden light through window' },
];

function pickWelcomeScenario() {
  return WELCOME_SCENARIOS[Math.floor(Math.random() * WELCOME_SCENARIOS.length)];
}

function buildProfileSummary(profileJson) {
  if (!profileJson) return '';
  try {
    const p = typeof profileJson === 'string' ? JSON.parse(profileJson) : profileJson;
    const o = p.onboarding || {};
    const parts = [];
    if (o.gender) parts.push(`gender: ${o.gender}`);
    if (o.age_range) parts.push(`age: ${o.age_range}`);
    if (o.daily_life) parts.push(`does: ${o.daily_life}${o.studying_what ? ' (' + o.studying_what + ')' : ''}${o.work_field ? ' (' + o.work_field + ')' : ''}`);
    if (o.day_vibe) parts.push(`days feel: ${o.day_vibe}`);
    if (Array.isArray(o.hobbies) && o.hobbies.length) parts.push(`hobbies: ${o.hobbies.join(', ')}`);
    if (o.personality) parts.push(`personality: ${o.personality}`);
    if (o.animals) parts.push(`animals: ${o.animals}${o.pet_type ? ' (' + o.pet_type + ')' : ''}`);
    if (o.relationship) parts.push(`relationship: ${o.relationship}`);
    if (o.kids) parts.push(`kids: ${o.kids}`);
    if (o.one_word) parts.push(`self-described as: ${o.one_word}`);
    // Last few check-ins
    const checkins = Array.isArray(p.checkins) ? p.checkins.slice(-5) : [];
    if (checkins.length) {
      const recent = checkins.map(c => {
        const a = c.answers || {};
        return Object.entries(a).map(([k, v]) => `${k}=${v}`).join(', ');
      }).filter(Boolean).join(' | ');
      if (recent) parts.push(`recent answers: ${recent}`);
    }
    return parts.join('. ');
  } catch (e) {
    return '';
  }
}

async function fetchRecentCaptions(env, userId, limit = 3) {
  const rows = await env.DB.prepare(
    `SELECT caption FROM generated_pieces WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`
  ).bind(userId, limit).all();
  return (rows.results || []).map(r => r.caption).filter(Boolean);
}

async function generateCaption(env, handle, diaryContent, profileSummary, recentCaptions) {
  const system = CAPTION_SYSTEM_PROMPT.replace(/\{handle\}/g, handle);
  const contextLines = [];
  if (profileSummary) contextLines.push(`User context: ${profileSummary}`);
  if (recentCaptions && recentCaptions.length) {
    contextLines.push(`Recent captions you wrote for them (don't repeat the same joke):\n- ${recentCaptions.join('\n- ')}`);
  }
  const userMsg = (contextLines.length ? contextLines.join('\n\n') + '\n\n' : '') + `diary: "${diaryContent.slice(0, 400)}" ->`;
  const res = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ],
    max_tokens: 80,
    temperature: 0.9,
  });
  let caption = (res?.response || '').trim();
  caption = caption.replace(/^["'`]+|["'`]+$/g, '').replace(/^->\s*/, '').trim();
  return caption.slice(0, 240) || `POV: @${handle} living that mainfeed life`;
}

async function generateImagePrompt(env, caption) {
  const res = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: IMAGE_PROMPT_SYSTEM },
      { role: 'user', content: `caption: "${caption}" ->` },
    ],
    max_tokens: 80,
    temperature: 0.7,
  });
  let prompt = (res?.response || '').trim();
  prompt = prompt.replace(/^["'`]+|["'`]+$/g, '').replace(/^->\s*/, '').trim();
  return prompt.slice(0, 400) || 'cinematic portrait of a young person, dramatic lighting';
}

function arrayBufferToBase64(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  const chunk = 8192;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, len)));
  }
  return btoa(binary);
}

async function getUserSelfieDataUrl(env, userId) {
  // Try selfie_0 ... selfie_9 across common extensions
  for (let i = 0; i < 10; i++) {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']) {
      const key = `selfies/${userId}/${i}.${ext}`;
      const obj = await env.SELFIES.get(key);
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        const b64 = arrayBufferToBase64(bytes);
        const mime = obj.httpMetadata?.contentType || `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        return `data:${mime};base64,${b64}`;
      }
    }
  }
  return null;
}

async function generateImageFalPulid(env, prompt, referenceImageDataUrl) {
  if (!env.FAL_API_KEY) return null;
  const body = {
    prompt,
    reference_image_url: referenceImageDataUrl,
    image_size: 'square_hd',
    num_inference_steps: 20,
    guidance_scale: 4,
    true_cfg: 1.0,
    id_weight: 1.0,
    enable_safety_checker: true,
    sync_mode: true, // block until image is ready; no polling needed
  };
  const res = await fetch('https://queue.fal.run/fal-ai/flux-pulid', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${env.FAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('fal.ai PuLID error', res.status, text.slice(0, 500));
    return null;
  }
  const data = await res.json().catch(() => null);
  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) {
    console.error('fal.ai PuLID returned no image url', JSON.stringify(data).slice(0, 400));
    return null;
  }
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    console.error('fal.ai image fetch failed', imgRes.status);
    return null;
  }
  return new Uint8Array(await imgRes.arrayBuffer());
}

async function generateImageWorkersAi(env, prompt) {
  const res = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
    prompt,
    steps: 4,
  });
  if (res?.image) {
    return Uint8Array.from(atob(res.image), (c) => c.charCodeAt(0));
  }
  return null;
}

async function generateImage(env, prompt, referenceImageDataUrl) {
  // Prefer Fal.ai PuLID (face-conditioned) when we have both a key and a selfie
  if (env.FAL_API_KEY && referenceImageDataUrl) {
    const bytes = await generateImageFalPulid(env, prompt, referenceImageDataUrl);
    if (bytes) return { bytes, provider: 'fal-flux-pulid' };
  }
  // Fall back to Workers AI Flux Schnell (no face)
  const bytes = await generateImageWorkersAi(env, prompt);
  if (bytes) return { bytes, provider: 'cf-workers-ai-flux-schnell' };
  return null;
}

async function generateOnePiece(env, userId, handle, diaryEntryId, diaryContent, ts, referenceImageDataUrl, profileSummary, recentCaptions) {
  try {
    const caption = await generateCaption(env, handle, diaryContent, profileSummary, recentCaptions);
    const imagePrompt = await generateImagePrompt(env, caption);
    const result = await generateImage(env, imagePrompt, referenceImageDataUrl);
    if (!result) return null;

    const pieceId = uid();
    const r2Key = `pieces/${userId}/${pieceId}.jpg`;
    await env.CONTENT.put(r2Key, result.bytes, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    await env.DB.prepare(
      `INSERT INTO generated_pieces
         (id, user_id, diary_entry_id, type, caption, r2_key, mime_type,
          generation_provider, generation_prompt, created_at, download_count, share_count)
       VALUES (?, ?, ?, 'image', ?, ?, 'image/jpeg', ?, ?, ?, 0, 0)`
    ).bind(pieceId, userId, diaryEntryId, caption, r2Key, result.provider, imagePrompt, ts).run();

    return pieceId;
  } catch (err) {
    console.error('piece generation failed', err);
    return null;
  }
}

async function generatePiecesForDiary(env, userId, handle, diaryEntryId, diaryContent, ts) {
  // ONE piece per diary entry. Cron handles volume separately.
  const [selfieDataUrl, profileRow, recentCaptions] = await Promise.all([
    getUserSelfieDataUrl(env, userId),
    env.DB.prepare('SELECT profile FROM users WHERE id = ?').bind(userId).first(),
    fetchRecentCaptions(env, userId, 3),
  ]);
  const profileSummary = buildProfileSummary(profileRow?.profile);

  const pieceId = await generateOnePiece(env, userId, handle, diaryEntryId, diaryContent, ts, selfieDataUrl, profileSummary, recentCaptions);
  const created = pieceId ? [pieceId] : [];

  if (created.length > 0) {
    await env.DB.prepare(
      'UPDATE diary_entries SET pieces_generated = ?, moderation_status = ? WHERE id = ?'
    ).bind(created.length, 'approved', diaryEntryId).run();
  }

  return created;
}

// Welcome piece — random POV scenario, no LLM calls (faster + consistent), face-conditioned via PuLID
// LEGACY — Flux+PuLID image welcome. Kept for backward-compat/fallback only.
// New signups use generateWelcomeVideoSwap() below.
async function generateWelcomePiece(env, userId, handle, ts) {
  try {
    const selfieDataUrl = await getUserSelfieDataUrl(env, userId);
    const scenario = pickWelcomeScenario();
    const result = await generateImage(env, scenario.prompt, selfieDataUrl);
    if (!result) return null;

    const pieceId = uid();
    const r2Key = `pieces/${userId}/${pieceId}.jpg`;
    await env.CONTENT.put(r2Key, result.bytes, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    await env.DB.prepare(
      `INSERT INTO generated_pieces
         (id, user_id, diary_entry_id, type, caption, r2_key, mime_type,
          generation_provider, generation_prompt, created_at, download_count, share_count)
       VALUES (?, ?, NULL, 'image', ?, ?, 'image/jpeg', ?, ?, ?, 0, 0)`
    ).bind(pieceId, userId, scenario.caption, r2Key, result.provider, scenario.prompt, ts).run();

    return pieceId;
  } catch (err) {
    console.error('welcome piece generation failed', err);
    return null;
  }
}

// Self-aware meta-humor caption pool for the welcome video (per locked welcome
// architecture decision). One is picked at random on signup.
const WELCOME_VIDEO_CAPTIONS = [
  'POV: just signed up for Mainfeed and already regret it',
  "Me telling Mainfeed AI to make me look cool. Mainfeed AI:",
  "POV: discovering this app means I'll never sleep again",
  "Me: I'll only use this once. Also me, 47 videos later:",
  'POV: just realized everything in my feed is me',
  "Me explaining why I have 50 cop videos of me on my camera roll",
];

function pickWelcomeCaption() {
  return WELCOME_VIDEO_CAPTIONS[Math.floor(Math.random() * WELCOME_VIDEO_CAPTIONS.length)];
}

// Queue the welcome video swap on the RunPod pod. Inserts a `processing`
// generated_pieces row immediately; the pod's /api/swap/complete callback
// flips it to `ready` (or `failed`) once the mp4 lands in R2.
async function generateWelcomeVideoSwap(env, userId, handle, gender, primarySelfieKey, appearanceBucket, ts) {
  if (!env.SWAP_POD_URL || !env.SWAP_POD_SECRET) {
    console.warn('welcome-video skipped: SWAP_POD_URL / SWAP_POD_SECRET not set');
    return null;
  }

  // Pick a stock clip for this user. Prefer bucket-matched if available;
  // otherwise fall back to any active clip of the user's gender for any scenario.
  let stock = null;
  if (appearanceBucket) {
    stock = await env.DB.prepare(
      `SELECT id, filename, r2_key, scenario, captions FROM stock_library
       WHERE active = 1 AND gender = ? AND appearance_bucket = ?
       ORDER BY RANDOM() LIMIT 1`
    ).bind(gender, appearanceBucket).first();
  }
  if (!stock) {
    stock = await env.DB.prepare(
      `SELECT id, filename, r2_key, scenario, captions FROM stock_library
       WHERE active = 1 AND gender = ?
       ORDER BY RANDOM() LIMIT 1`
    ).bind(gender).first();
  }
  if (!stock) {
    console.warn('welcome-video skipped: no active stock clip available');
    return null;
  }

  // Build a signed-ish public stock URL the pod can fetch over plain HTTPS.
  // The mainfeed-stock bucket exposes /public/stock/<filename>.mp4 (no auth).
  const stockBaseName = String(stock.filename || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  const targetVideoUrl = `https://api.mainfeed.app/public/stock/${stockBaseName}.mp4`;

  // Generate piece_id BEFORE the temp selfie upload so we can key the temp
  // file by the per-swap UUID instead of the persistent userId. This closes
  // the cross-user selfie leak vector — previously stock/_welcome_src_<userId>.jpg
  // was publicly fetchable by anyone who knew a userId (which appears in logs
  // and is not a secret). With piece_id as the key, brute-forcing requires
  // guessing a 122-bit UUID, and the file is cleaned up on callback OR by the
  // hourly janitor cron (whichever fires first). Audit 2026-05-26 C3.
  const pieceId = uid();
  const r2Key = `generated/${pieceId}.mp4`;
  const caption = pickWelcomeCaption();

  const sel = await env.SELFIES.get(primarySelfieKey);
  if (!sel) {
    console.error('welcome-video skipped: primary selfie missing in R2', { primarySelfieKey });
    return null;
  }
  const tempStockKey = `stock/_welcome_src_${pieceId}.jpg`;
  await env.STOCK.put(tempStockKey, sel.body, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  const sourceImageUrlFlat = `https://api.mainfeed.app/public/stock/_welcome_src_${pieceId}.jpg`;

  // Insert pending generated_pieces row BEFORE firing pod, so the feed shows a
  // placeholder immediately and the callback has a row to update.
  await env.DB.prepare(
    `INSERT INTO generated_pieces
       (id, user_id, diary_entry_id, type, caption, r2_key, mime_type,
        generation_provider, generation_prompt, created_at, download_count, share_count,
        status, scenario, stock_library_id)
     VALUES (?, ?, NULL, 'video', ?, ?, 'video/mp4', 'dreamidv-faster', NULL, ?, 0, 0, 'processing', ?, ?)`
  ).bind(pieceId, userId, caption, r2Key, ts, stock.scenario || null, stock.id).run();

  // Fire pod swap. request_id = pieceId so the callback finds the row directly.
  // caption + handle are sent so the pod burns them into the video frames —
  // see pod/render_overlay.py. Without these, downloaded clips would lose
  // all branding when re-shared to TikTok/IG.
  const payload = {
    request_id: pieceId,
    source_image_url: sourceImageUrlFlat,
    target_video_url: targetVideoUrl,
    callback_url: 'https://api.mainfeed.app/api/swap/complete',
    output_r2_key: r2Key,
    sample_steps: 16,
    sample_guide_scale_img: 4.0,
    size: '832*480',
    // 3s @ 24fps = 81 frames (DreamID-V default). Reverted from 120 on
    // 2026-05-26 LATE EVENING — videos are no longer the focal share
    // format, memes + cosplay images are. 3s is cheap + matches DreamID-V's
    // default chunking behavior cleanly. Don't pass — let the pod default apply.
    frame_num: 81,
    caption,
    handle,
  };

  const podSwapUrl = env.SWAP_POD_URL.replace(/\/+$/, '') + '/swap';
  try {
    const res = await fetchPodWithRetry(podSwapUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SWAP_POD_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      await env.DB.prepare(
        `UPDATE generated_pieces SET status = 'failed', caption = ? WHERE id = ?`
      ).bind(`(welcome failed — pod ${res.status}) ${caption}`, pieceId).run();
      console.error('welcome-video pod queue failed', res.status, errText.slice(0, 200));
    }
  } catch (err) {
    await env.DB.prepare(
      `UPDATE generated_pieces SET status = 'failed', caption = ? WHERE id = ?`
    ).bind(`(welcome failed — pod unreachable) ${caption}`, pieceId).run();
    console.error('welcome-video pod fetch exception', err);
  }

  return pieceId;
}

// Internal helper: classify a selfie stored in an R2 bucket binding into an appearance bucket.
// Returns null on any error; caller is expected to tolerate that.
async function detectAppearanceFromR2(env, r2Key, bucketName, gender) {
  if (!env.AI) return null;
  const bucket = env[bucketName] || env.SELFIES || env.STOCK;
  if (!bucket) return null;
  const obj = await bucket.get(r2Key);
  if (!obj) return null;
  const imageBytes = new Uint8Array(await obj.arrayBuffer());

  const aiArgs = {
    prompt: APPEARANCE_PROMPT,
    image: [...imageBytes],
    max_tokens: 256,
  };

  let aiResp;
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', aiArgs);
  } catch (err) {
    const msg = String(err).slice(0, 800);
    if (msg.includes("5016") || msg.toLowerCase().includes("must submit the prompt 'agree'")) {
      try {
        await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
        aiResp = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', aiArgs);
      } catch (_) { return null; }
    } else {
      return null;
    }
  }

  let attrs = null;
  if (aiResp && typeof aiResp === 'object') {
    if (aiResp.response && typeof aiResp.response === 'object') {
      attrs = aiResp.response;
    } else {
      const cand = (typeof aiResp.response === 'string' ? aiResp.response
                   : typeof aiResp.result === 'string' ? aiResp.result : '').trim();
      const m = cand.match(/\{[\s\S]*\}/);
      if (m) { try { attrs = JSON.parse(m[0]); } catch (_) {} }
    }
  }
  if (!attrs || !attrs.gender) return null;
  if (gender === 'm' || gender === 'f') attrs.gender = gender;
  return _pickBucket(attrs);
}

// ============ Check-in cards (popup questions to deepen profile) ============

const CHECKIN_POOL = [
  { id: 'today_mood', text: 'How was today, really?', type: 'single', options: ['great', 'good', 'mid', 'rough', "i don't wanna talk about it"] },
  { id: 'best_part_today', text: 'Best part of today?', type: 'text', placeholder: 'one line' },
  { id: 'worst_part_today', text: 'Anything ruin your day?', type: 'text', placeholder: 'or leave blank' },
  { id: 'sleep_hours', text: 'How much sleep did you get?', type: 'single', options: ['8+ hours', '6-8', '4-6', 'less than 4 lol'] },
  { id: 'morning_night', text: 'Morning person or night owl?', type: 'single', options: ['morning', 'night', 'somewhere in between'] },
  { id: 'coffee_tea', text: 'Coffee or tea?', type: 'single', options: ['coffee', 'tea', 'both', 'neither'] },
  { id: 'going_out_tonight', text: 'Going out tonight or staying in?', type: 'single', options: ['going out', 'staying in', "haven't decided", 'depends on the vibe'] },
  { id: 'vacation_dream', text: 'Where would you wanna be right now?', type: 'text', placeholder: 'place or vibe' },
  { id: 'pet_peeve', text: "What's a small thing that pisses you off?", type: 'text' },
  { id: 'cooking', text: 'Do you cook?', type: 'single', options: ['yes love it', 'kinda', 'i order in', 'i microwave'] },
  { id: 'gym', text: 'Gym situation?', type: 'single', options: ['regular', 'sometimes', 'never been', 'membership i never use'] },
  { id: 'environment', text: 'Do you care about the environment?', type: 'single', options: ['yes a lot', 'kinda', 'not really', 'i recycle that\'s it'] },
  { id: 'red_flag', text: 'Biggest red flag in someone?', type: 'text' },
  { id: 'guilty_pleasure', text: 'Guilty pleasure?', type: 'text' },
  { id: 'last_cried', text: 'Last time you cried?', type: 'single', options: ['this week', 'this month', 'this year', "can't remember", "don't cry"] },
  { id: 'social_battery', text: 'Social battery this week?', type: 'single', options: ['full', 'medium', 'running low', 'dead'] },
  { id: 'weekend_vibe', text: 'Ideal weekend?', type: 'single', options: ['out with people', 'home alone in bed', 'something productive', 'mix of all'] },
  { id: 'biggest_lie', text: 'Biggest lie you tell yourself?', type: 'text' },
  { id: 'comfort_food', text: 'Comfort food?', type: 'text' },
  { id: 'last_app', text: 'Last app you opened before mainfeed?', type: 'single', options: ['instagram', 'tiktok', 'x/twitter', 'whatsapp', 'something else'] },
];

async function handleCheckinQuestions(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;
  // Pick 3 random questions the user hasn't answered yet (lightweight — just random for v0)
  const userRow = await env.DB.prepare('SELECT profile FROM users WHERE id = ?').bind(r.session.user_id).first();
  let answered = new Set();
  try {
    const p = JSON.parse(userRow?.profile || '{}');
    for (const c of (p.checkins || [])) {
      for (const k of Object.keys(c.answers || {})) answered.add(k);
    }
  } catch {}
  const pool = CHECKIN_POOL.filter(q => !answered.has(q.id));
  const sample = pool.length ? pool : CHECKIN_POOL; // fall back to all if exhausted
  // Random 3 (or however many remain)
  const shuffled = [...sample].sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, 3);
  return json({ ok: true, questions: picks }, {}, origin);
}

async function handleCheckinSubmit(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const rl = await rateLimit(env, `checkin:${r.session.user_id}`, 20, 3600);
  if (!rl.allowed) return errResp('rate_limited', 429, origin);

  const body = await request.json().catch(() => ({}));
  const answers = body?.answers && typeof body.answers === 'object' ? body.answers : null;
  if (!answers) return errResp('empty_answers', 400, origin);

  // Validate keys are known + values are strings/arrays
  const validIds = new Set(CHECKIN_POOL.map(q => q.id));
  const clean = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!validIds.has(k)) continue;
    if (typeof v === 'string') clean[k] = v.slice(0, 200);
    else if (Array.isArray(v)) clean[k] = v.slice(0, 10).map(x => String(x).slice(0, 100));
  }
  if (Object.keys(clean).length === 0) return errResp('no_valid_answers', 400, origin);

  // Merge into user's profile.checkins
  const userRow = await env.DB.prepare('SELECT profile FROM users WHERE id = ?').bind(r.session.user_id).first();
  let profile = {};
  try { profile = JSON.parse(userRow?.profile || '{}'); } catch {}
  if (!profile.checkins) profile.checkins = [];
  profile.checkins.push({ ts: now(), answers: clean });
  // Cap last 50 check-ins to keep profile size sane
  if (profile.checkins.length > 50) profile.checkins = profile.checkins.slice(-50);
  await env.DB.prepare('UPDATE users SET profile = ? WHERE id = ?').bind(JSON.stringify(profile), r.session.user_id).run();

  // Trigger a piece based on the new info (treat answers as a synthetic diary entry)
  const synthetic = Object.entries(clean).map(([k, v]) => {
    const q = CHECKIN_POOL.find(x => x.id === k);
    const qt = q ? q.text : k;
    return `${qt} ${Array.isArray(v) ? v.join(', ') : v}`;
  }).join('. ');

  if (synthetic) {
    const ts = now();
    const entryId = uid();
    await env.DB.prepare(
      `INSERT INTO diary_entries (id, user_id, content, created_at, pieces_generated, moderation_status)
       VALUES (?, ?, ?, ?, 0, 'approved')`
    ).bind(entryId, r.session.user_id, '[checkin] ' + synthetic, ts).run();
    // Fire-and-forget the piece generation (don't block response — user sees it appear on next feed refresh)
    // Actually for sync UX, await briefly:
    await generatePiecesForDiary(env, r.session.user_id, r.session.handle, entryId, synthetic, ts);
  }

  return json({ ok: true, saved: Object.keys(clean).length }, {}, origin);
}

// ============ Diary ============

async function handleDiaryCreate(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const rl = await rateLimit(env, `diary:${r.session.user_id}`, 30, 3600);
  if (!rl.allowed) return errResp('rate_limited', 429, origin);

  const body = await request.json().catch(() => ({}));
  const content = String(body.content || '').trim();
  if (content.length < 1) return errResp('empty_entry', 400, origin);
  if (content.length > 500) return errResp('too_long', 400, origin);

  const entryId = uid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO diary_entries (id, user_id, content, created_at, pieces_generated, moderation_status)
     VALUES (?, ?, ?, ?, 0, 'pending')`
  ).bind(entryId, r.session.user_id, content, ts).run();

  // Generate pieces synchronously (Workers AI is fast enough; ~10s total for 3 pieces)
  const pieceIds = await generatePiecesForDiary(
    env, r.session.user_id, r.session.handle, entryId, content, ts
  );

  return json(
    {
      ok: true,
      entry_id: entryId,
      pieces_generated: pieceIds.length,
      piece_ids: pieceIds,
    },
    {}, origin
  );
}

// ============ Router ============

// Scheduled (cron) handler — runs every 5 min via the [triggers] block in
// wrangler.toml. Audit 2026-05-26 H1: pieces stuck in 'processing' state
// because the pod never callbacked (crash, OOM, network blip) were
// previously invisible to the user (feed filters to 'ready') AND occupied
// orphan public selfie files. This sweeps them.
async function runJanitor(env) {
  // created_at is stored in SECONDS (worker now() convention) — compare in
  // seconds, NOT against Date.now() (ms), which treats every piece as ~50,000
  // years old and reaps it mid-bake (this silently nuked every Storytime piece
  // each cron tick; the old welcome flow was immune only because it left
  // created_at NULL). 45 min covers a full serial day-bake (~15 min) + backlog
  // headroom. NOTE: the trial-week pre-bake queues ~140 pieces (hours of serial
  // GPU) — before that ships, gate the sweep on an inactive bake_job, not wall
  // clock, or legit deep-queue pieces will be reaped.
  const STUCK_THRESHOLD_SEC = 45 * 60; // 45 min
  const cutoff = Math.floor(Date.now() / 1000) - STUCK_THRESHOLD_SEC;
  const stuck = await env.DB.prepare(
    `SELECT id, user_id FROM generated_pieces
     WHERE status = 'processing' AND created_at < ?
     LIMIT 200`
  ).bind(cutoff).all();

  const rows = stuck.results || [];
  if (rows.length === 0) {
    console.log('[janitor] nothing stuck');
    return { swept: 0 };
  }

  for (const row of rows) {
    try {
      await env.DB.prepare(
        "UPDATE generated_pieces SET status = 'failed' WHERE id = ? AND status = 'processing'"
      ).bind(row.id).run();
      // Clean up the per-piece temp selfie if it's still there.
      try { await env.STOCK.delete(`stock/_welcome_src_${row.id}.jpg`); } catch (_) {}
    } catch (err) {
      console.error('[janitor] failed to sweep', row.id, err);
    }
  }
  console.log('[janitor] swept', rows.length, 'stuck pieces');
  return { swept: rows.length };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJanitor(env));
    // Storytime: advance the next active bake job by one day per tick.
    ctx.waitUntil(runBaker(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: cors(origin) });
    }

    // Health
    if (method === 'GET' && (path === '/' || path === '/api/health')) {
      return json({ ok: true, name: 'mainfeed-api', env: env.ENVIRONMENT || 'unknown' }, {}, origin);
    }

    // Auth
    if (method === 'POST' && path === '/api/signup') return handleSignup(request, env, origin);
    if (method === 'POST' && path === '/api/login') return handleLogin(request, env, origin);
    if (method === 'POST' && path === '/api/logout') return handleLogout(request, env, origin);
    if (method === 'GET' && path === '/api/me') return handleMe(request, env, origin);
    if (method === 'POST' && path === '/api/verify-identity') return handleVerifyIdentity(request, env, origin);

    // Feed
    if (method === 'GET' && path === '/api/feed') return handleFeed(request, env, ctx, origin);

    // Storytime feed: arc → day list, and one day's pieces
    if (method === 'GET' && path === '/api/saga/days') return handleSagaDays(request, env, origin);
    if (method === 'GET' && path === '/api/saga/day') return handleSagaDay(request, env, origin);
    if (method === 'POST' && path === '/api/admin/rebake-day') return handleAdminRebakeDay(request, env, origin);
    if (method === 'POST' && path === '/api/admin/reswap-piece') return handleAdminReswapPiece(request, env, origin);

    // Piece (file stream, delete, publish toggle)
    const pieceFileMatch = path.match(/^\/api\/piece\/([A-Za-z0-9_-]+)\/file$/);
    if (method === 'GET' && pieceFileMatch) return handlePieceFile(request, env, origin, pieceFileMatch[1]);
    const piecePublicFileMatch = path.match(/^\/api\/piece\/([A-Za-z0-9_-]+)\/public-file$/);
    if (method === 'GET' && piecePublicFileMatch) return handlePublicPieceFile(request, env, origin, piecePublicFileMatch[1]);
    const piecePublishMatch = path.match(/^\/api\/piece\/([A-Za-z0-9_-]+)\/publish$/);
    if (method === 'POST' && piecePublishMatch) return handlePiecePublish(request, env, origin, piecePublishMatch[1], true);
    const pieceUnpublishMatch = path.match(/^\/api\/piece\/([A-Za-z0-9_-]+)\/unpublish$/);
    if (method === 'POST' && pieceUnpublishMatch) return handlePiecePublish(request, env, origin, pieceUnpublishMatch[1], false);
    const pieceDeleteMatch = path.match(/^\/api\/piece\/([A-Za-z0-9_-]+)$/);
    if (method === 'DELETE' && pieceDeleteMatch) return handlePieceDelete(request, env, origin, pieceDeleteMatch[1]);

    // Public profile
    const profileMatch = path.match(/^\/api\/profile\/([a-z0-9]+)$/);
    if (method === 'GET' && profileMatch) return handlePublicProfile(request, env, origin, profileMatch[1]);

    // Diary
    if (method === 'POST' && path === '/api/diary/create') return handleDiaryCreate(request, env, origin);

    // Check-in cards
    if (method === 'GET' && path === '/api/checkin/questions') return handleCheckinQuestions(request, env, origin);
    if (method === 'POST' && path === '/api/checkin/submit') return handleCheckinSubmit(request, env, origin);

    // Admin: stock library batch generation + download
    if (method === 'POST' && path === '/api/admin/batch-gen-stock') return handleAdminBatchGenStock(request, env, origin);
    if (method === 'POST' && path === '/api/admin/stock/collect') return handleAdminStockCollect(request, env, origin);
    if (method === 'POST' && path === '/api/admin/stock/wipe-scenario') return handleAdminStockWipeScenario(request, env, origin);
    if (method === 'GET' && path === '/api/admin/stock/list') return handleAdminStockList(request, env, origin);
    const stockFileMatch = path.match(/^\/api\/admin\/stock\/file\/([A-Za-z0-9_.-]+)$/);
    if (method === 'GET' && stockFileMatch) return handleAdminStockFile(request, env, origin, stockFileMatch[1]);

    // Admin: queue a DreamID-V swap on the RunPod pod (proxies to swap_server.py /swap)
    if (method === 'POST' && path === '/api/admin/swap/queue') return handleAdminSwapQueue(request, env, origin);
    // Admin: queue a Flux+PuLID cosplay-image generation (10/day quota, see [[mainfeed_image_library_architecture]])
    if (method === 'POST' && path === '/api/admin/image/queue') return handleAdminImageQueue(request, env, origin);
    // Admin: one-shot HF -> R2 mirror via the worker's env.CONTENT binding.
    // Bypasses wrangler r2 object put's 300 MiB cap (we needed this for the
    // Flux+PuLID weight mirror — flux1-schnell.safetensors is 24 GB).
    if (method === 'POST' && path === '/api/admin/mirror-hf-to-r2') return handleAdminMirrorHfToR2(request, env, origin);
    // Pod-callback: pod posts here when a swap completes/fails (authed via SWAP_POD_SECRET, not ADMIN_TOKEN)
    if (method === 'POST' && path === '/api/swap/complete') return handleSwapComplete(request, env, origin);
    // Pod-upload: pod streams swap-output mp4 here (authed via SWAP_POD_SECRET). Worker writes
    // to R2 via binding so the pod never holds R2 creds (audit 2026-05-27).
    if (method === 'POST' && path === '/api/swap/upload') return handleSwapUpload(request, env, origin);
    // Pod-weight-read: pod GETs weight files from r2://mainfeed-content/models/<...>
    // via this proxy (authed via SWAP_POD_SECRET). Symmetric to /api/swap/upload —
    // worker holds R2 access via env.CONTENT binding, pod never needs R2 creds.
    if (method === 'GET' && path === '/api/pod/weight') return handlePodWeightRead(request, env, origin);

    // Admin: classify a selfie into one of the 40 hair+skin appearance buckets (Llama 3.2 Vision)
    if (method === 'POST' && path === '/api/admin/detect-appearance') return handleAdminDetectAppearance(request, env, origin);

    // Public: stock files (no auth, so external services can fetch as input to swap pipeline)
    const publicStockMatch = path.match(/^\/public\/stock\/([A-Za-z0-9_.-]+)$/);
    if (method === 'GET' && publicStockMatch) return handlePublicStockFile(request, env, origin, publicStockMatch[1]);

    return errResp('not_found', 404, origin, { path });
  },
};

// ============ ADMIN: stock library batch generation via Fal.ai ============

function checkAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return token && env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

// v4 model (LOCKED 2026-05-24 evening): Veo 3.1 Fast at $0.10/s no-audio @ 1080p 9:16.
// 6s default = $0.60/clip. Replaces Hunyuan as default. Hunyuan path retained for back-compat
// and any explicit { model: 'hunyuan' } tasks. Veo handles photoreal + absurd backgrounds
// much better — required for the "alive + absurd" v4 prompt recipe.
async function falVeo31FastQueue(env, prompt, opts = {}) {
  if (!env.FAL_API_KEY) return { error: 'no_fal_key' };
  const body = {
    prompt,
    aspect_ratio: '9:16',
    resolution: opts.resolution || '1080p',
    duration: opts.duration || '6s',
    generate_audio: false,
    auto_fix: true,
  };
  const res = await fetch('https://queue.fal.run/fal-ai/veo3.1/fast', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${env.FAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `fal_${res.status}`, detail: text.slice(0, 300) };
  }
  const data = await res.json().catch(() => null);
  const requestId = data?.request_id;
  if (!requestId) {
    return { error: 'no_request_id', detail: JSON.stringify(data).slice(0, 300) };
  }
  return {
    request_id: requestId,
    status_url: data.status_url || `https://queue.fal.run/fal-ai/veo3.1/requests/${requestId}/status`,
    response_url: data.response_url || `https://queue.fal.run/fal-ai/veo3.1/requests/${requestId}`,
  };
}

async function falVeo31FastCheckAndCollect(env, requestId) {
  if (!env.FAL_API_KEY) return { error: 'no_fal_key' };
  // Veo's queue submit goes to fal-ai/veo3.1/fast but the status/result endpoints
  // live at fal-ai/veo3.1/requests/... (Fal collapses the /fast variant for status polling).
  const statusUrl = `https://queue.fal.run/fal-ai/veo3.1/requests/${requestId}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/veo3.1/requests/${requestId}`;

  const sres = await fetch(statusUrl, {
    headers: { 'Authorization': `Key ${env.FAL_API_KEY}` },
  });
  if (!sres.ok) {
    const text = await sres.text().catch(() => '');
    return { error: `status_${sres.status}`, detail: text.slice(0, 300) };
  }
  const sdata = await sres.json().catch(() => null);
  if (!sdata) return { error: 'bad_status_json' };
  if (sdata.status === 'FAILED' || sdata.status === 'ERROR') {
    return { error: 'fal_failed', detail: JSON.stringify(sdata).slice(0, 300) };
  }
  if (sdata.status !== 'COMPLETED') {
    return { collected: false, status: sdata.status || 'UNKNOWN' };
  }

  const rres = await fetch(resultUrl, {
    headers: { 'Authorization': `Key ${env.FAL_API_KEY}` },
  });
  if (!rres.ok) {
    const text = await rres.text().catch(() => '');
    return { error: `result_${rres.status}`, detail: text.slice(0, 300) };
  }
  const rdata = await rres.json().catch(() => null);
  const videoUrl = rdata?.video?.url;
  if (!videoUrl) {
    return { error: 'no_video_url', detail: JSON.stringify(rdata).slice(0, 300) };
  }

  const vres = await fetch(videoUrl);
  if (!vres.ok) return { error: 'video_download_failed', detail: `status ${vres.status}` };
  const bytes = new Uint8Array(await vres.arrayBuffer());
  return { collected: true, bytes, fal_video_url: videoUrl };
}

// Queue a Hunyuan video generation request — returns immediately with the Fal queue ticket
// LEGACY (v3 path). Use Veo 3.1 Fast for v4. Hunyuan retained for any in-flight v3 work
// or explicit { model: 'hunyuan' } overrides.
async function falHunyuanQueue(env, prompt) {
  if (!env.FAL_API_KEY) return { error: 'no_fal_key' };
  const body = {
    prompt,
    aspect_ratio: '9:16',
    resolution: '480p',
    num_frames: 121,        // ~5s at 24fps
    enable_safety_checker: true,
  };
  const res = await fetch('https://queue.fal.run/fal-ai/hunyuan-video-v1.5/text-to-video', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${env.FAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `fal_${res.status}`, detail: text.slice(0, 300) };
  }
  const data = await res.json().catch(() => null);
  const requestId = data?.request_id;
  if (!requestId) {
    return { error: 'no_request_id', detail: JSON.stringify(data).slice(0, 300) };
  }
  return {
    request_id: requestId,
    status_url: data.status_url || `https://queue.fal.run/fal-ai/hunyuan-video-v1.5/requests/${requestId}/status`,
    response_url: data.response_url || `https://queue.fal.run/fal-ai/hunyuan-video-v1.5/requests/${requestId}`,
  };
}

// Check a queued Fal request and, if ready, download the video bytes
// Returns { collected: true, bytes, fal_video_url } if the clip is ready
//      or { collected: false, status } if Fal is still processing (caller should retry later)
//      or { error, detail } if Fal failed the job or auth issue
async function falHunyuanCheckAndCollect(env, requestId) {
  if (!env.FAL_API_KEY) return { error: 'no_fal_key' };
  const statusUrl = `https://queue.fal.run/fal-ai/hunyuan-video-v1.5/requests/${requestId}/status`;
  const resultUrl = `https://queue.fal.run/fal-ai/hunyuan-video-v1.5/requests/${requestId}`;

  const sres = await fetch(statusUrl, {
    headers: { 'Authorization': `Key ${env.FAL_API_KEY}` },
  });
  if (!sres.ok) {
    const text = await sres.text().catch(() => '');
    return { error: `status_${sres.status}`, detail: text.slice(0, 300) };
  }
  const sdata = await sres.json().catch(() => null);
  if (!sdata) return { error: 'bad_status_json' };
  if (sdata.status === 'FAILED' || sdata.status === 'ERROR') {
    return { error: 'fal_failed', detail: JSON.stringify(sdata).slice(0, 300) };
  }
  if (sdata.status !== 'COMPLETED') {
    return { collected: false, status: sdata.status || 'UNKNOWN' };
  }

  const rres = await fetch(resultUrl, {
    headers: { 'Authorization': `Key ${env.FAL_API_KEY}` },
  });
  if (!rres.ok) {
    const text = await rres.text().catch(() => '');
    return { error: `result_${rres.status}`, detail: text.slice(0, 300) };
  }
  const rdata = await rres.json().catch(() => null);
  const videoUrl = rdata?.video?.url || rdata?.videos?.[0]?.url;
  if (!videoUrl) {
    return { error: 'no_video_url', detail: JSON.stringify(rdata).slice(0, 300) };
  }

  const vres = await fetch(videoUrl);
  if (!vres.ok) return { error: 'video_download_failed', detail: `status ${vres.status}` };
  const bytes = new Uint8Array(await vres.arrayBuffer());
  return { collected: true, bytes, fal_video_url: videoUrl };
}

// POST /api/admin/batch-gen-stock — queue a batch of stock clips at Fal in parallel
// Body: { tasks: [ { filename, scenario, gender, variant, prompt, use_for, captions, mood, face_swap_needed, tags, composition }, ... ] }
// Returns: { ok, results: [{ filename, status: 'queued'|'failed', request_id?, status_url?, response_url?, error?, detail? }] }
// Caller MUST follow up with POST /api/admin/stock/collect (passing back the same metadata + request_ids
// from this response) to actually collect the videos once Fal finishes processing (~60-120s per clip).
async function handleAdminBatchGenStock(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);

  const body = await request.json().catch(() => ({}));
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  if (tasks.length === 0) return errResp('empty_batch', 400, origin);
  if (tasks.length > 50) return errResp('batch_too_large', 400, origin);

  const results = await Promise.all(tasks.map(async (t) => {
    const filename = String(t.filename || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
    if (!filename) return { filename: '', status: 'failed', error: 'invalid_filename' };
    const model = String(t.model || 'veo3.1-fast').trim();
    try {
      let q;
      if (model === 'veo3.1-fast') {
        q = await falVeo31FastQueue(env, String(t.prompt || ''), {
          duration: t.duration || '6s',
          resolution: t.resolution || '1080p',
        });
      } else if (model === 'hunyuan') {
        q = await falHunyuanQueue(env, String(t.prompt || ''));
      } else {
        return { filename, status: 'failed', error: 'unknown_model', detail: model };
      }
      if (q.error) return { filename, status: 'failed', error: q.error, detail: q.detail };
      return {
        filename,
        status: 'queued',
        model,
        request_id: q.request_id,
        status_url: q.status_url,
        response_url: q.response_url,
      };
    } catch (err) {
      return { filename, status: 'failed', error: String(err).slice(0, 200) };
    }
  }));
  return json({ ok: true, results }, {}, origin);
}

// POST /api/admin/stock/collect — collect READY Fal video requests + persist to R2 + D1
// Body: { items: [{ request_id, filename, scenario, gender, variant, use_for, captions, mood, face_swap_needed, tags, composition }, ...] }
// For each item: checks Fal status; if COMPLETED, downloads + R2 put + DB insert.
// Idempotent — items with `filename` already in stock_library are skipped with status 'already_collected'.
// Returns: { ok, results: [{ filename, status: 'collected'|'pending'|'already_collected'|'failed', ... }] }
// Caller should loop calling this every ~15-30s until all items are no longer 'pending'.
async function handleAdminStockCollect(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);

  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return errResp('empty', 400, origin);
  if (items.length > 50) return errResp('batch_too_large', 400, origin);

  const results = await Promise.all(items.map(async (it) => {
    const filename = String(it.filename || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
    const requestId = String(it.request_id || '');
    const model = String(it.model || 'hunyuan').trim();
    if (!filename || !requestId) return { filename, status: 'failed', error: 'missing_fields' };

    // Idempotency: skip if already collected
    try {
      const existing = await env.DB.prepare(
        `SELECT id FROM stock_library WHERE filename = ? LIMIT 1`
      ).bind(filename).first();
      if (existing) return { filename, status: 'already_collected', stock_id: existing.id };
    } catch (err) {
      // best-effort; continue
    }

    try {
      let c, width, height, source, duration;
      if (model === 'veo3.1-fast') {
        c = await falVeo31FastCheckAndCollect(env, requestId);
        width = 1080; height = 1920; source = 'fal-veo31-fast';
        duration = parseFloat(String(it.duration || '6s').replace('s', '')) || 6.0;
      } else if (model === 'hunyuan') {
        c = await falHunyuanCheckAndCollect(env, requestId);
        width = 480; height = 848; source = 'fal-hunyuan'; duration = 5.0;
      } else {
        return { filename, status: 'failed', error: 'unknown_model', detail: model };
      }
      if (c.error) return { filename, status: 'failed', error: c.error, detail: c.detail };
      if (c.collected === false) return { filename, status: 'pending', fal_status: c.status };

      const r2Key = `stock/${filename}.mp4`;
      await env.STOCK.put(r2Key, c.bytes, {
        httpMetadata: { contentType: 'video/mp4' },
      });
      const stockId = uid();
      const ts = now();
      await env.DB.prepare(
        `INSERT INTO stock_library
           (id, r2_key, type, source, source_id, duration, width, height,
            mood, scenario, composition, tags, face_track_data, active, created_at,
            gender, variant, filename, captions, face_swap_needed, use_for)
         VALUES (?, ?, 'video', ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, NULL, 1, ?,
                 ?, ?, ?, ?, ?, ?)`
      ).bind(
        stockId, r2Key, source, requestId, duration, width, height,
        String(it.mood || ''), String(it.scenario || ''),
        String(it.composition || 'mid'),
        Array.isArray(it.tags) ? it.tags.join(',') : String(it.tags || ''),
        ts,
        String(it.gender || 'unisex'),
        Number(it.variant || 1),
        filename,
        Array.isArray(it.captions) ? it.captions.join('|') : String(it.captions || ''),
        it.face_swap_needed === false ? 0 : 1,
        Array.isArray(it.use_for) ? it.use_for.join(',') : String(it.use_for || '')
      ).run();
      return { filename, status: 'collected', stock_id: stockId, r2_key: r2Key, bytes: c.bytes.length, model };
    } catch (err) {
      return { filename, status: 'failed', error: String(err).slice(0, 200) };
    }
  }));
  return json({ ok: true, results }, {}, origin);
}

// POST /api/admin/stock/wipe-scenario — wipe all clips for a scenario from D1 + R2 (auth-gated, requires confirm:true)
// Body: { scenario: 'cop', confirm: true }
// Returns: { ok, deleted_count, deleted: [filenames] }
async function handleAdminStockWipeScenario(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);

  const body = await request.json().catch(() => ({}));
  const scenario = String(body.scenario || '').trim().slice(0, 64);
  if (!scenario) return errResp('missing_scenario', 400, origin);
  if (body.confirm !== true) return errResp('confirm_required', 400, origin);

  let clips = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT id, r2_key, filename FROM stock_library WHERE scenario = ?`
    ).bind(scenario).all();
    clips = rows.results || [];
  } catch (err) {
    return errResp('db_query_failed', 500, origin, { detail: String(err).slice(0, 200) });
  }

  if (clips.length === 0) {
    return json({ ok: true, deleted_count: 0, deleted: [] }, {}, origin);
  }

  // Delete from R2 in parallel (best-effort)
  await Promise.all(clips.map(c => {
    if (!c.r2_key) return Promise.resolve();
    return env.STOCK.delete(c.r2_key).catch(() => null);
  }));

  // Delete from D1
  try {
    await env.DB.prepare(`DELETE FROM stock_library WHERE scenario = ?`).bind(scenario).run();
  } catch (err) {
    return errResp('db_delete_failed', 500, origin, { detail: String(err).slice(0, 200) });
  }

  return json({ ok: true, deleted_count: clips.length, deleted: clips.map(c => c.filename) }, {}, origin);
}

// GET /api/admin/stock/list — list all clips in stock library (auth-gated)
async function handleAdminStockList(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);
  const rows = await env.DB.prepare(
    `SELECT id, filename, scenario, variant, gender, mood, use_for, captions, r2_key, created_at, active, face_swap_needed
     FROM stock_library ORDER BY created_at DESC LIMIT 500`
  ).all();
  return json({ ok: true, clips: rows.results || [] }, {}, origin);
}

// GET /api/admin/stock/file/:filename — download the MP4 (auth-gated)
async function handleAdminStockFile(request, env, origin, filename) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);
  const safeName = filename.replace(/[^A-Za-z0-9_.-]/g, '_');
  const r2Key = `stock/${safeName}`;
  const obj = await env.STOCK.get(r2Key);
  if (!obj) return errResp('not_found', 404, origin);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
      ...cors(origin),
    },
  });
}

// GET /public/stock/:filename — PUBLIC (no auth) stock file serving so external services can fetch as swap input.
// Filename must include extension (e.g. cop_s09_patrol_shimmy_f.mp4).
//
// Defense-in-depth for temp selfie files (`_welcome_src_<pieceId>.jpg`,
// audit 2026-05-26 C4): require any filename starting with `_welcome_src_`
// to match `_welcome_src_<uuid-v4>.jpg` exactly. Other underscore-prefixed
// keys (or malformed UUIDs) get 404'd before R2 is even consulted, blocking
// brute-force scrapes / enumeration of internal naming patterns.
async function handlePublicStockFile(request, env, origin, filename) {
  const safeName = filename.replace(/[^A-Za-z0-9_.-]/g, '_');

  if (safeName.startsWith('_')) {
    const TEMP_SELFIE_PATTERN = /^_welcome_src_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;
    if (!TEMP_SELFIE_PATTERN.test(safeName)) return errResp('not_found', 404, origin);
  }

  const r2Key = `stock/${safeName}`;
  const obj = await env.STOCK.get(r2Key);
  if (!obj) return errResp('not_found', 404, origin);

  // For temp selfies, set no-store so CDN doesn't cache. The cleanup-on-callback
  // would otherwise be undermined by a cached copy living in CF's edge.
  const isTempSelfie = safeName.startsWith('_welcome_src_');
  const contentType = isTempSelfie ? 'image/jpeg' : 'video/mp4';
  const cacheControl = isTempSelfie ? 'no-store, private' : 'public, max-age=3600';

  return new Response(obj.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ============ Fal storage upload helper (used by Hunyuan batch-gen + future inputs) ============
// 2-step REST flow: https://rest.alpha.fal.ai/storage/auth/token?storage_type=fal-cdn-v3 → token + upload_url → PUT.
async function falUploadBytes(env, bytes, filename, contentType) {
  if (!env.FAL_API_KEY) return { error: 'no_fal_key' };
  try {
    const tokenRes = await fetch('https://rest.alpha.fal.ai/storage/auth/token?storage_type=fal-cdn-v3', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${env.FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file_name: filename, content_type: contentType }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text().catch(() => '');
      return { error: `token_${tokenRes.status}`, detail: t.slice(0, 400) };
    }
    const tokenData = await tokenRes.json().catch(() => null);
    if (!tokenData) return { error: 'token_bad_json' };
    // Fal's storage auth response shape (observed): { upload_url, file_url } — upload_url is a pre-signed PUT URL.
    // Older docs may show { token, base_url } — handle both.
    const uploadUrl = tokenData.upload_url || (tokenData.base_url ? `${tokenData.base_url}/files/upload` : null);
    if (!uploadUrl) {
      return { error: 'no_upload_url', detail: JSON.stringify(tokenData).slice(0, 400) };
    }
    // Pre-signed URLs typically expect PUT with no auth header; legacy base_url+token uses POST with Bearer.
    const isPresigned = !tokenData.token;
    const uploadHeaders = { 'Content-Type': contentType };
    if (!isPresigned) uploadHeaders['Authorization'] = `Bearer ${tokenData.token}`;
    const uploadRes = await fetch(uploadUrl, {
      method: isPresigned ? 'PUT' : 'POST',
      headers: uploadHeaders,
      body: bytes,
    });
    if (!uploadRes.ok) {
      const t = await uploadRes.text().catch(() => '');
      return { error: `upload_${uploadRes.status}`, detail: t.slice(0, 400), upload_url: uploadUrl, method: isPresigned ? 'PUT' : 'POST' };
    }
    // Presigned PUT returns empty body — the access URL is tokenData.file_url already.
    // POST returns JSON with { access_url }.
    let accessUrl = tokenData.file_url;
    if (!isPresigned) {
      const uploadData = await uploadRes.json().catch(() => null);
      accessUrl = uploadData?.access_url || uploadData?.url || accessUrl;
    }
    if (!accessUrl) {
      const respText = await uploadRes.text().catch(() => '');
      return { error: 'no_access_url', detail: `tokenData=${JSON.stringify(tokenData).slice(0, 200)} | uploadResp=${respText.slice(0, 200)}` };
    }
    return { access_url: accessUrl };
  } catch (err) {
    return { error: 'upload_exception', detail: String(err).slice(0, 400) };
  }
}

// ============ DreamID-V swap pod integration ============
// SWAP_POD_URL    e.g. https://ocg8daon2bxzio-8000.proxy.runpod.net  (set via `wrangler secret put`)
// SWAP_POD_SECRET shared bearer token between worker and pod's swap_server.py

function checkPodSecret(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return !!token && !!env.SWAP_POD_SECRET && token === env.SWAP_POD_SECRET;
}

// POST /api/admin/swap/queue
// Body (JSON): {
//   source_image_url:  string (anything the pod can fetch — Fal CDN, our public/selfie, etc.)
//   target_filename:   string (basename without extension — e.g. "cop_s07_coffee_plaza_f")
//   request_id?:       string (auto-generated if missing)
//   output_r2_key?:    string (key in mainfeed-content; default "generated/<request_id>.mp4")
//   sample_steps?:     int (default 16)
//   sample_guide_scale_img?: float (default 4.0)
//   size?:             string (default "832*480")
// }
// Forwards to ${SWAP_POD_URL}/swap with Authorization: Bearer ${SWAP_POD_SECRET}.
async function handleAdminSwapQueue(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);
  if (!env.SWAP_POD_URL) return errResp('swap_pod_url_not_set', 500, origin, {
    hint: 'wrangler secret put SWAP_POD_URL  (e.g. https://<podid>-8000.proxy.runpod.net)',
  });
  if (!env.SWAP_POD_SECRET) return errResp('swap_pod_secret_not_set', 500, origin, {
    hint: 'wrangler secret put SWAP_POD_SECRET  (same value as on the pod)',
  });

  const body = await request.json().catch(() => ({}));
  const sourceImageUrl = String(body.source_image_url || '').trim();
  const targetFilename = String(body.target_filename || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  // Require user_id since 2026-05-26 — admin swaps now always create an
  // owned generated_pieces row so the output file at generated/<pieceId>.mp4
  // is never an orphan (would otherwise be a vector for piece-collision /
  // overwrite of a real user's piece if request_id is reused). Audit C1.
  const userId = String(body.user_id || '').trim();
  const caption = typeof body.caption === 'string' ? body.caption : null;
  const handle = typeof body.handle === 'string' ? body.handle : null;
  if (!sourceImageUrl) return errResp('missing_source_image_url', 400, origin);
  if (!targetFilename) return errResp('missing_target_filename', 400, origin);
  if (!userId) return errResp('missing_user_id', 400, origin, {
    hint: 'pass "user_id" in the body — admin swaps must be attached to a real user so the piece row is owned + cleaned up correctly',
  });

  // Verify the user exists. Without this an attacker with the admin token
  // could inject pieces into D1 keyed to non-existent users, leaking storage.
  const userRow = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!userRow) return errResp('user_not_found', 404, origin, { user_id: userId });

  // Verify the stock clip exists before sending the pod off on a wild goose chase
  const stockKey = `stock/${targetFilename}.mp4`;
  const stockHead = await env.STOCK.head(stockKey);
  if (!stockHead) return errResp('stock_not_found', 404, origin, { stock_key: stockKey });

  const requestId = String(body.request_id || crypto.randomUUID());
  const targetVideoUrl = `https://api.mainfeed.app/public/stock/${targetFilename}.mp4`;
  const callbackUrl = 'https://api.mainfeed.app/api/swap/complete';
  const outputR2Key = `generated/${requestId}.mp4`;
  // Reject body-supplied output_r2_key — admin should never override the
  // pieceId-keyed default since it'd un-tie the file from the piece row.
  if (body.output_r2_key && body.output_r2_key !== outputR2Key) {
    return errResp('output_r2_key_not_overridable', 400, origin, {
      hint: 'output_r2_key is auto-derived from request_id; do not pass it',
    });
  }

  // Refuse to clobber an existing piece. With UUID request_ids the collision
  // chance is ~0, but enforcing the invariant lets us safely INSERT below.
  const existing = await env.DB.prepare(
    'SELECT id FROM generated_pieces WHERE id = ?'
  ).bind(requestId).first();
  if (existing) {
    return errResp('request_id_collision', 409, origin, {
      hint: 'a piece with that id already exists — pass a fresh request_id or omit it to auto-generate',
    });
  }

  // INSERT the piece row BEFORE firing pod so callback has a target +
  // ownership/cleanup are tracked from the start.
  const ts = Date.now();
  await env.DB.prepare(
    `INSERT INTO generated_pieces
       (id, user_id, diary_entry_id, type, caption, r2_key, mime_type,
        generation_provider, generation_prompt, created_at, download_count,
        share_count, status, scenario, stock_library_id)
     VALUES (?, ?, NULL, 'video', ?, ?, 'video/mp4', 'dreamidv-faster-admin', NULL, ?, 0, 0, 'processing', 'admin_test', NULL)`
  ).bind(requestId, userId, caption, outputR2Key, ts).run();

  const payload = {
    request_id: requestId,
    source_image_url: sourceImageUrl,
    target_video_url: targetVideoUrl,
    target_pose_url: body.target_pose_url || null,
    target_mask_url: body.target_mask_url || null,
    callback_url: callbackUrl,
    output_r2_key: outputR2Key,
    sample_steps: Number.isFinite(body.sample_steps) ? Number(body.sample_steps) : 16,
    sample_guide_scale_img: Number.isFinite(body.sample_guide_scale_img)
      ? Number(body.sample_guide_scale_img) : 4.0,
    // DreamID-V argparse only accepts 832*480 / 480*832 / 720*1280 / 1280*720 / 1024*1024 (asterisk-separated).
    size: typeof body.size === 'string' ? body.size : '832*480',
    // 3s @ 24fps = 81 frames (DreamID-V default). Mainfeed standard 2026-05-26.
    frame_num: Number.isFinite(body.frame_num) ? Number(body.frame_num) : 81,
    // Pod burns these into the video (caption top + watermark bar) per
    // pod/render_overlay.py. Optional — omit them in admin tests to skip burn-in.
    caption,
    handle,
  };

  const podUrl = env.SWAP_POD_URL.replace(/\/+$/, '') + '/swap';
  let res;
  try {
    res = await fetchPodWithRetry(podUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SWAP_POD_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Mark the row failed so it doesn't sit `processing` forever.
    try {
      await env.DB.prepare("UPDATE generated_pieces SET status = 'failed' WHERE id = ?").bind(requestId).run();
    } catch (_) {}
    return errResp('pod_unreachable', 502, origin, {
      pod_url: podUrl,
      detail: String(err).slice(0, 400),
    });
  }

  const podText = await res.text().catch(() => '');
  let podJson = null;
  try { podJson = JSON.parse(podText); } catch (_) { /* keep as text */ }

  if (!res.ok) {
    try {
      await env.DB.prepare("UPDATE generated_pieces SET status = 'failed' WHERE id = ?").bind(requestId).run();
    } catch (_) {}
    return errResp(`pod_${res.status}`, 502, origin, {
      pod_url: podUrl,
      pod_response: podJson || podText.slice(0, 400),
    });
  }

  return json({
    ok: true,
    request_id: requestId,
    pod_url: podUrl,
    target_video_url: targetVideoUrl,
    callback_url: callbackUrl,
    output_r2_key: outputR2Key,
    pod_response: podJson || podText.slice(0, 400),
  }, {}, origin);
}

// POST /api/admin/reswap-piece — re-render an EXISTING piece IN PLACE: swap the
// owner's face onto a given stock clip at a chosen size/frame_num, overwriting
// the piece's R2 file. The piece keeps its arc/day/scene/caption/reveal_at
// tagging — only the video bytes change. Used to drop a real arc clip (e.g. a
// true 1:1 jungle video) onto a piece that was baked against placeholder stock.
// Status is NOT touched here: the piece stays visible (old file) until the pod's
// callback flips it ready with the new bytes; a hard-refresh shows the new clip.
// Body: { piece_id, stock_key (filename in STOCK), size?, frame_num? }
async function handleAdminReswapPiece(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);
  const body = await request.json().catch(() => ({}));
  const pieceId = String(body.piece_id || '').trim();
  const stockName = String(body.stock_key || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_');
  const size = typeof body.size === 'string' ? body.size : '832*480';
  const frameNum = Number.isFinite(body.frame_num) ? Number(body.frame_num) : 81;
  if (!pieceId || !stockName) return errResp('missing_fields', 400, origin, { hint: 'need piece_id + stock_key' });

  const piece = await env.DB.prepare(
    'SELECT id, user_id, r2_key, type FROM generated_pieces WHERE id = ? AND deleted_at IS NULL'
  ).bind(pieceId).first();
  if (!piece) return errResp('piece_not_found', 404, origin);

  const user = await env.DB.prepare(
    'SELECT id, handle, primary_selfie_r2_key FROM users WHERE id = ? AND deleted_at IS NULL'
  ).bind(piece.user_id).first();
  if (!user || !user.primary_selfie_r2_key) return errResp('user_or_selfie_missing', 404, origin);

  const stockKey = `stock/${stockName}`;
  if (!(await env.STOCK.head(stockKey))) return errResp('stock_not_found', 404, origin, { stock_key: stockKey });

  // Stage the owner's selfie as a public temp file (same convention as the bake;
  // /api/swap/complete deletes stock/_welcome_src_<piece.id>.jpg on callback).
  const sel = await env.SELFIES.get(user.primary_selfie_r2_key);
  if (!sel) return errResp('selfie_object_missing', 404, origin);
  await env.STOCK.put(`stock/_welcome_src_${piece.id}.jpg`, sel.body, { httpMetadata: { contentType: 'image/jpeg' } });

  const payload = {
    request_id: piece.id,                                        // callback flips THIS piece
    source_image_url: `https://api.mainfeed.app/public/stock/_welcome_src_${piece.id}.jpg`,
    target_video_url: `https://api.mainfeed.app/public/stock/${stockName}`,
    target_pose_url: null,
    target_mask_url: null,
    callback_url: 'https://api.mainfeed.app/api/swap/complete',
    output_r2_key: piece.r2_key,                                 // overwrite in place
    sample_steps: 16,
    sample_guide_scale_img: 4.0,
    size,
    frame_num: frameNum,
    handle: user.handle,
  };

  const podUrl = env.SWAP_POD_URL.replace(/\/+$/, '') + '/swap';
  let res;
  try {
    res = await fetchPodWithRetry(podUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.SWAP_POD_SECRET}` },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return errResp('pod_unreachable', 502, origin, { detail: String(err).slice(0, 400) });
  }
  const podText = await res.text().catch(() => '');
  let podJson = null; try { podJson = JSON.parse(podText); } catch (_) { /* keep text */ }
  if (!res.ok) return errResp(`pod_${res.status}`, 502, origin, { pod_response: podJson || podText.slice(0, 400) });

  return json({
    ok: true, piece_id: piece.id, output_r2_key: piece.r2_key, size, frame_num: frameNum,
    pod_response: podJson || podText.slice(0, 200),
  }, {}, origin);
}

// POST /api/admin/image/queue
// Body (JSON): {
//   user_id:           string (required — image is attached to a real user)
//   template_id?:      string (optional — if omitted, Layer A picks an unseen template)
//   prompt_override?:  string (optional — bypass template, use this exact prompt; for one-off tests)
//   request_id?:       string (auto-generated if missing)
//   base_seed?:        int (default 42)
//   id_weight?:        float (default 1.0 — PuLID identity injection strength)
//   start_step?:       int (default 0 — denoise step to begin ID injection)
//   num_steps?:        int (default 4 — Flux.1-schnell turbo)
// }
//
// Layer A uniqueness query: prefers templates this user has never seen.
// Within the chosen template, slot values are filled with RANDOM picks; the
// filled prompt is then checked against (user_id, image_template_id,
// generation_prompt) — if it collides we re-roll up to 5 times before giving
// up (extremely unlikely in practice, see [[mainfeed_uniqueness_guarantee]]
// for the math).
//
// Flow: pick template + slots → fill prompt → INSERT pending piece →
// stage user's selfie as a public temp file (keyed by piece_id, same pattern
// as the welcome-video swap) → POST to pod /image → pod callbacks
// /api/swap/complete with status='completed' + r2_key on success.
async function handleAdminImageQueue(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);
  if (!env.SWAP_POD_URL) return errResp('swap_pod_url_not_set', 500, origin, {
    hint: 'wrangler secret put SWAP_POD_URL  (e.g. https://<podid>-8000.proxy.runpod.net)',
  });
  if (!env.SWAP_POD_SECRET) return errResp('swap_pod_secret_not_set', 500, origin);

  const body = await request.json().catch(() => ({}));
  const userId = String(body.user_id || '').trim();
  if (!userId) return errResp('missing_user_id', 400, origin);

  // Fetch user — need appearance_bucket (for {bucket_phrase}) and the primary
  // selfie key (the PuLID identity source).
  const userRow = await env.DB.prepare(
    `SELECT id, handle, appearance_bucket, primary_selfie_r2_key
       FROM users WHERE id = ? AND deleted_at IS NULL`
  ).bind(userId).first();
  if (!userRow) return errResp('user_not_found', 404, origin, { user_id: userId });
  if (!userRow.primary_selfie_r2_key) return errResp('user_no_selfie', 400, origin, {
    hint: 'user has no primary_selfie_r2_key — they must complete signup before images can be generated',
  });

  // === Pick template + fill slots ===
  let template, filledPrompt;
  if (typeof body.prompt_override === 'string' && body.prompt_override.trim().length > 0) {
    // One-off test path — no template, just use the supplied prompt verbatim.
    template = null;
    filledPrompt = String(body.prompt_override).slice(0, 2000);
  } else {
    const explicitTemplateId = typeof body.template_id === 'string' ? body.template_id : null;
    const picked = await pickImageTemplateAndPrompt(env, userId, userRow.appearance_bucket, explicitTemplateId);
    if (!picked) return errResp('no_template_available', 503, origin, {
      hint: 'no unseen template+slot combination for this user (full exhaustion) — Layer B fallback not yet implemented',
    });
    template = picked.template;
    filledPrompt = picked.filledPrompt;
  }

  const requestId = String(body.request_id || crypto.randomUUID());

  // Refuse to clobber an existing piece.
  const existing = await env.DB.prepare('SELECT id FROM generated_pieces WHERE id = ?').bind(requestId).first();
  if (existing) return errResp('request_id_collision', 409, origin);

  const pieceId = requestId;
  const r2Key = `generated/${pieceId}.jpg`;

  // Stage selfie as a temp public file the pod can fetch over plain HTTPS.
  // Same pattern as generateWelcomeVideoSwap: keyed by piece_id (UUID), not
  // user_id, so the URL isn't bruteforceable from log-leaked user_ids.
  const sel = await env.SELFIES.get(userRow.primary_selfie_r2_key);
  if (!sel) return errResp('selfie_missing_in_r2', 500, origin, {
    primary_selfie_r2_key: userRow.primary_selfie_r2_key,
  });
  const tempStockKey = `stock/_welcome_src_${pieceId}.jpg`;
  await env.STOCK.put(tempStockKey, sel.body, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  const sourceImageUrl = `https://api.mainfeed.app/public/stock/_welcome_src_${pieceId}.jpg`;

  // Insert pending row. Images: type='image', stock_library_id=NULL,
  // image_template_id set, generation_prompt = filled prompt, mime image/jpeg.
  const ts = Date.now();
  await env.DB.prepare(
    `INSERT INTO generated_pieces
       (id, user_id, diary_entry_id, type, caption, r2_key, mime_type,
        generation_provider, generation_prompt, created_at, download_count, share_count,
        status, scenario, stock_library_id, image_template_id, width, height)
     VALUES (?, ?, NULL, 'image', '', ?, 'image/jpeg', 'flux-pulid', ?, ?, 0, 0,
             'processing', NULL, NULL, ?, 1024, 1024)`
  ).bind(
    pieceId, userId, r2Key, filledPrompt, ts,
    template ? template.id : null,
  ).run();

  const payload = {
    request_id: pieceId,
    source_image_url: sourceImageUrl,
    prompt: filledPrompt,
    callback_url: 'https://api.mainfeed.app/api/swap/complete',
    output_r2_key: r2Key,
    width: 1024,
    height: 1024,
    num_steps: Number.isFinite(body.num_steps) ? Number(body.num_steps) : 4,
    guidance: Number.isFinite(body.guidance) ? Number(body.guidance) : 4.0,
    id_weight: Number.isFinite(body.id_weight) ? Number(body.id_weight) : 1.0,
    start_step: Number.isFinite(body.start_step) ? Number(body.start_step) : 0,
    base_seed: Number.isFinite(body.base_seed) ? Number(body.base_seed) : 42,
    handle: userRow.handle || null,
  };

  const podUrl = env.SWAP_POD_URL.replace(/\/+$/, '') + '/image';
  let res;
  try {
    res = await fetchPodWithRetry(podUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SWAP_POD_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    try {
      await env.DB.prepare("UPDATE generated_pieces SET status = 'failed' WHERE id = ?").bind(pieceId).run();
    } catch (_) {}
    return errResp('pod_unreachable', 502, origin, {
      pod_url: podUrl,
      detail: String(err).slice(0, 400),
    });
  }

  const podText = await res.text().catch(() => '');
  let podJson = null;
  try { podJson = JSON.parse(podText); } catch (_) { /* keep as text */ }

  if (!res.ok) {
    try {
      await env.DB.prepare("UPDATE generated_pieces SET status = 'failed' WHERE id = ?").bind(pieceId).run();
    } catch (_) {}
    return errResp(`pod_${res.status}`, 502, origin, {
      pod_url: podUrl,
      pod_response: podJson || podText.slice(0, 400),
    });
  }

  return json({
    ok: true,
    request_id: pieceId,
    pod_url: podUrl,
    template_id: template ? template.id : null,
    filled_prompt: filledPrompt,
    output_r2_key: r2Key,
    pod_response: podJson || podText.slice(0, 400),
  }, {}, origin);
}

// Pick an image template + fill its slots so the filled prompt is unseen by
// this user. Layer A from [[mainfeed_uniqueness_guarantee]]: prefer templates
// the user has never used; within a template, re-roll slot values until the
// filled prompt is unseen (5-attempt cap).
//
// Returns { template, filledPrompt } on success, or null if no unseen
// (template, filled_prompt) combination exists for the user.
async function pickImageTemplateAndPrompt(env, userId, appearanceBucket, explicitTemplateId) {
  const bucketP = bucketPhrase(appearanceBucket);

  // Step 1: find candidate templates. If explicit template_id passed, use only
  // that one. Otherwise prefer never-seen templates first, then fall back to
  // any active template (slot re-roll will still produce uniqueness).
  let candidates;
  if (explicitTemplateId) {
    const row = await env.DB.prepare(
      `SELECT id, category, prompt_template, slots FROM image_templates
        WHERE id = ? AND active = 1`
    ).bind(explicitTemplateId).first();
    if (!row) return null;
    candidates = [row];
  } else {
    // Never-seen-by-this-user templates, ordered random.
    const unseenRows = await env.DB.prepare(
      `SELECT t.id, t.category, t.prompt_template, t.slots FROM image_templates t
        WHERE t.active = 1
          AND NOT EXISTS (
            SELECT 1 FROM generated_pieces gp
             WHERE gp.user_id = ?
               AND gp.image_template_id = t.id
               AND gp.deleted_at IS NULL
          )
        ORDER BY RANDOM() LIMIT 5`
    ).bind(userId).all();
    candidates = (unseenRows && unseenRows.results) ? unseenRows.results : [];

    if (candidates.length === 0) {
      // All templates have been used at least once — fall back to all active.
      const fallback = await env.DB.prepare(
        `SELECT id, category, prompt_template, slots FROM image_templates
          WHERE active = 1 ORDER BY RANDOM() LIMIT 5`
      ).all();
      candidates = (fallback && fallback.results) ? fallback.results : [];
    }
  }

  // Step 2: for each candidate, try up to 5 slot re-rolls to find an unseen
  // filled prompt. With ~125 combos per template, collisions are rare unless
  // the user has filled deep into the template's slot space.
  for (const tpl of candidates) {
    let slots;
    try {
      slots = JSON.parse(String(tpl.slots || '{}'));
    } catch (_) {
      continue;
    }
    const slotNames = Object.keys(slots).filter(k => Array.isArray(slots[k]) && slots[k].length > 0);

    for (let attempt = 0; attempt < 5; attempt++) {
      let prompt = String(tpl.prompt_template);
      // {bucket_phrase} is special — sourced from BUCKET_PROMPT_FRAGMENTS, not template slots.
      prompt = prompt.replaceAll('{bucket_phrase}', bucketP);
      for (const slotName of slotNames) {
        const values = slots[slotName];
        const pick = values[Math.floor(Math.random() * values.length)];
        prompt = prompt.replaceAll('{' + slotName + '}', String(pick));
      }

      // Check uniqueness for this user.
      const seen = await env.DB.prepare(
        `SELECT id FROM generated_pieces
          WHERE user_id = ? AND image_template_id = ? AND generation_prompt = ?
            AND deleted_at IS NULL LIMIT 1`
      ).bind(userId, tpl.id, prompt).first();

      if (!seen) {
        return { template: tpl, filledPrompt: prompt };
      }
    }
  }

  return null;
}


// POST /api/admin/mirror-hf-to-r2
// One-shot streaming mirror: fetch a HuggingFace file (optionally gated, with
// HF_TOKEN auth) and write it to R2 via the env.CONTENT binding. Workers'
// fetch->R2 path has no 300 MiB cap (unlike `wrangler r2 object put` from the
// host machine). Streaming happens entirely on Cloudflare's network — bytes
// never come back to the caller.
//
// Used to mirror Flux.1-schnell + AE + PuLID adapter weights to our R2 bucket
// for the gating-insulated cold-boot path (see [[mainfeed_flux_schnell_gated_on_hf]]
// and [[mainfeed_image_library_architecture]]).
//
// Body (JSON): {
//   hf_repo:     "black-forest-labs/FLUX.1-schnell"   (required)
//   hf_filename: "flux1-schnell.safetensors"         (required)
//   hf_token:    "hf_..."                            (required for gated repos)
//   r2_key:      "models/flux_pulid/flux1-schnell.safetensors" (required, must start with "models/")
// }
//
// Auth: Authorization: Bearer ${ADMIN_TOKEN}
async function handleAdminMirrorHfToR2(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);

  const body = await request.json().catch(() => ({}));
  const hfRepo     = String(body.hf_repo || '').trim();
  const hfFilename = String(body.hf_filename || '').trim();
  const hfToken    = String(body.hf_token || '').trim();
  const r2Key      = String(body.r2_key || '').trim();

  if (!hfRepo || !hfFilename) return errResp('missing_hf_target', 400, origin);
  if (!r2Key) return errResp('missing_r2_key', 400, origin);
  // Hard-restrict to models/ — keeps this admin tool from being abused to
  // write outside the models prefix (e.g. clobber generated/ or stock/).
  if (!r2Key.startsWith('models/')) {
    return errResp('r2_key_must_start_with_models', 400, origin, { r2_key: r2Key });
  }
  if (r2Key.includes('..') || r2Key.includes('//')) {
    return errResp('invalid_r2_key', 400, origin, { r2_key: r2Key });
  }

  const hfUrl = `https://huggingface.co/${hfRepo}/resolve/main/${hfFilename}`;
  const headers = {};
  if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

  const t0 = Date.now();
  let upstream;
  try {
    upstream = await fetch(hfUrl, { headers, redirect: 'follow' });
  } catch (err) {
    return errResp('hf_fetch_failed', 502, origin, { detail: String(err).slice(0, 400) });
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return errResp(`hf_${upstream.status}`, 502, origin, {
      hf_url: hfUrl,
      hf_body: errText.slice(0, 400),
      hint: upstream.status === 401 ? 'gated repo — pass a hf_token that has accepted the repo terms' : undefined,
    });
  }

  if (!upstream.body) {
    return errResp('hf_no_body', 502, origin);
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const contentLength = upstream.headers.get('content-length');

  // env.CONTENT.put accepts a ReadableStream — bytes stream through the Worker
  // edge directly to R2 storage without buffering the full body in memory.
  // For multi-GB files (flux1-schnell.safetensors is 24 GB) this is the only
  // viable path inside a Worker.
  try {
    await env.CONTENT.put(r2Key, upstream.body, {
      httpMetadata: { contentType },
    });
  } catch (err) {
    return errResp('r2_put_failed', 500, origin, { detail: String(err).slice(0, 400) });
  }

  const elapsedMs = Date.now() - t0;
  return json({
    ok: true,
    r2_bucket: 'mainfeed-content',
    r2_key: r2Key,
    content_length: contentLength,
    elapsed_ms: elapsedMs,
  }, {}, origin);
}


// POST /api/swap/complete
// Called by the pod when a swap finishes (success or failure).
// Authed via Authorization: Bearer ${SWAP_POD_SECRET}.
// Body (JSON): { request_id, status: 'completed'|'failed', elapsed_sec?, error?,
//                output_bytes?, r2_bucket?, r2_key? }
//
// For now this is a logging stub — it records the result via console and returns ok.
// When the production user→swap flow is wired, this will:
//   - Look up the pending generated_pieces row by request_id
//   - Update status='ready' / 'failed' and store r2_key
//   - Trigger a Web Push notification to the user's device
async function handleSwapComplete(request, env, origin) {
  if (!checkPodSecret(request, env)) return errResp('unauthorized', 401, origin);
  const body = await request.json().catch(() => ({}));
  const requestId = String(body.request_id || '');
  const status = String(body.status || '');
  if (!requestId || !status) return errResp('missing_fields', 400, origin);

  console.log('[swap.complete]', JSON.stringify({
    request_id: requestId, status,
    elapsed_sec: body.elapsed_sec, error: body.error,
    output_bytes: body.output_bytes, r2_bucket: body.r2_bucket, r2_key: body.r2_key,
  }));

  // Production wiring: the worker's generated_pieces row was inserted with
  // status='processing' and id=requestId. Flip it to 'ready' or 'failed'.
  const piece = await env.DB.prepare(
    'SELECT id, user_id, status, r2_key FROM generated_pieces WHERE id = ?'
  ).bind(requestId).first();
  if (piece) {
    // Defense-in-depth: if the pod reports back a different r2_key than the
    // one we issued at queue time, refuse to flip status to ready. Prevents
    // a pod-side bug from delivering Output A as Piece B's file. Audit
    // 2026-05-26 C2.
    const callbackR2Key = typeof body.r2_key === 'string' ? body.r2_key : null;
    const r2KeyMismatch = status === 'completed'
      && callbackR2Key && piece.r2_key && callbackR2Key !== piece.r2_key;

    if (r2KeyMismatch) {
      await env.DB.prepare(
        `UPDATE generated_pieces SET status = 'failed' WHERE id = ?`
      ).bind(requestId).run();
      console.error('[swap.complete] r2_key mismatch — refusing to mark ready', {
        request_id: requestId,
        expected: piece.r2_key,
        got: callbackR2Key,
      });
    } else if (status === 'completed') {
      await env.DB.prepare(
        `UPDATE generated_pieces
           SET status = 'ready'
         WHERE id = ?`
      ).bind(requestId).run();
    } else {
      const errMsg = String(body.error || 'pod_failed').slice(0, 400);
      await env.DB.prepare(
        `UPDATE generated_pieces SET status = 'failed' WHERE id = ?`
      ).bind(requestId).run();
      console.error('[swap.complete] piece marked failed', { request_id: requestId, error: errMsg });
    }

    // Best-effort cleanup of the temporary public selfie copy. Keyed by
    // piece.id now (was piece.user_id pre-2026-05-26), closing the leak
    // where one persistent key was reused across all of a user's signups.
    try {
      await env.STOCK.delete(`stock/_welcome_src_${piece.id}.jpg`);
    } catch (_) {}
  } else {
    console.warn('[swap.complete] no matching piece for request_id', requestId);
  }

  return json({ ok: true, ack: requestId }, {}, origin);
}

// POST /api/swap/upload?key=generated/<request_id>.mp4
// The pod uploads its swap output mp4 here. Worker holds R2 access via the
// `env.CONTENT` binding — pod never needs R2 credentials. Replaces the
// previous direct-S3 boto3 upload from pod, which would leak R2 creds onto
// community hardware (third-party hosts can read container env vars).
//
// Auth: Authorization: Bearer ${SWAP_POD_SECRET}.
// Body: raw mp4 binary (Content-Type: video/mp4). Workers body cap is 100 MB,
//       well above our ~3 MB swap outputs.
// Query: ?key=generated/<request_id>.mp4  (must be under generated/ prefix —
//        rejects any attempt to write to users/, models/, etc.)
async function handleSwapUpload(request, env, origin) {
  if (!checkPodSecret(request, env)) return errResp('unauthorized', 401, origin);

  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  // Hard-restrict to generated/ — a compromised pod must not be able to
  // overwrite user selfies, model weights, brand assets, or any other prefix.
  if (!key.startsWith('generated/')) {
    return errResp('invalid_key_prefix', 400, origin, {
      hint: 'key must start with "generated/" — pod uploads are scoped to generated outputs only',
    });
  }
  // Path-traversal + extension guard. Images (Flux+PuLID, 10/day quota) use
  // .jpg; videos and GIFs use .mp4. Both land under generated/ — extension
  // tells the worker which content-type to enforce.
  if (key.includes('..')) return errResp('invalid_key', 400, origin, { key });
  const isVideo = key.endsWith('.mp4');
  const isImage = key.endsWith('.jpg');
  if (!isVideo && !isImage) {
    return errResp('invalid_key_extension', 400, origin, {
      hint: 'key must end in .mp4 (video/GIF) or .jpg (Flux+PuLID cosplay image)',
      key,
    });
  }

  const contentType = request.headers.get('Content-Type') || (isVideo ? 'video/mp4' : 'image/jpeg');
  if (isVideo && !contentType.startsWith('video/')) {
    return errResp('invalid_content_type', 400, origin, { contentType, expected: 'video/*' });
  }
  if (isImage && !contentType.startsWith('image/')) {
    return errResp('invalid_content_type', 400, origin, { contentType, expected: 'image/*' });
  }

  // Pre-check Content-Length so honest oversized clients get rejected
  // BEFORE we read 100 MB of bandwidth/memory. Belt-and-braces: still
  // re-check actual byteLength after read in case the header lies.
  const MAX_BYTES = 100 * 1024 * 1024;
  const clHeader = request.headers.get('Content-Length');
  const declaredLen = clHeader != null ? parseInt(clHeader, 10) : null;
  if (declaredLen != null && Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
    return errResp('body_too_large', 413, origin, {
      hint: '100 MB max',
      declared: declaredLen,
    });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return errResp('empty_body', 400, origin);
  if (body.byteLength > MAX_BYTES) {
    return errResp('body_too_large', 413, origin, { hint: '100 MB max' });
  }

  await env.CONTENT.put(key, body, {
    httpMetadata: { contentType: isImage ? 'image/jpeg' : 'video/mp4' },
  });

  return json({
    ok: true,
    bucket: 'mainfeed-content',
    key,
    size: body.byteLength,
  }, {}, origin);
}

// GET /api/pod/weight?key=models/<...>
// The pod fetches mirrored weight files (Flux base, AE, PuLID adapter,
// antelopev2, DreamID-V, Wan-2.1, DWPose) via this proxy. Symmetric to
// /api/swap/upload — auth via SWAP_POD_SECRET (already on pod), restricted
// to the models/ prefix so a compromised pod can't read anywhere else in
// the bucket. Stream-through: bytes never buffer in Worker memory.
//
// This is the pattern that keeps R2 credentials off the pod entirely
// ([[feedback_no_secrets_on_pod]]) — same way /api/swap/upload removed
// write creds, /api/pod/weight removes read creds.
async function handlePodWeightRead(request, env, origin) {
  if (!checkPodSecret(request, env)) return errResp('unauthorized', 401, origin);

  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  // Hard-restrict to models/ — pod must never use this proxy to read
  // selfies, generated outputs, stock clips, or anything outside the mirror.
  if (!key.startsWith('models/')) {
    return errResp('invalid_key_prefix', 400, origin, {
      hint: 'key must start with "models/" — pod weight reads are scoped to the mirror only',
    });
  }
  if (key.includes('..') || key.includes('//')) {
    return errResp('invalid_key', 400, origin, { key });
  }

  const obj = await env.CONTENT.get(key);
  if (!obj) return errResp('not_found', 404, origin, { key });

  // Stream-through: the worker doesn't hold the body in memory. R2 binding's
  // .body is a ReadableStream and the Response constructor pipes it directly.
  // For 24 GB flux1-schnell.safetensors this matters — no buffering possible.
  const headers = new Headers({
    'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (obj.size != null) headers.set('Content-Length', String(obj.size));
  if (obj.etag) headers.set('ETag', obj.etag);
  // Manually add CORS — pod doesn't care about origin but be consistent.
  const corsHeaders = cors(origin);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);

  return new Response(obj.body, { status: 200, headers });
}


// ============ Appearance-bucket detection (Llama 3.2 Vision) ============
//
// 40 hair+skin buckets per the v5 architecture. Llama 3.2 Vision classifies the
// user's selfie(s) along the structured attributes below, then a deterministic
// mapping picks the closest of the 40 bucket keys. (Asking Llama to pick the
// key directly is unreliable — too many similar options. Structured classify +
// rule-based map is more robust.)

const APPEARANCE_BUCKETS = [
  // Male (15)
  { key: 'm_bald',                       gender: 'm', length: 'bald',   color: 'any',         texture: 'any',      style: 'any',  skin: 'any' },
  { key: 'm_buzz_dark_med',              gender: 'm', length: 'buzz',   color: 'black',       texture: 'straight', style: 'down', skin: 'medium' },
  { key: 'm_buzz_light_fair',            gender: 'm', length: 'buzz',   color: 'blonde',      texture: 'straight', style: 'down', skin: 'fair' },
  { key: 'm_short_dark_straight_brown',  gender: 'm', length: 'short',  color: 'black',       texture: 'straight', style: 'down', skin: 'medium' },
  { key: 'm_short_dark_straight_fair',   gender: 'm', length: 'short',  color: 'black',       texture: 'straight', style: 'down', skin: 'fair' },
  { key: 'm_short_blonde_straight_pale', gender: 'm', length: 'short',  color: 'blonde',      texture: 'straight', style: 'down', skin: 'pale' },
  { key: 'm_short_dark_coily_deep',      gender: 'm', length: 'short',  color: 'black',       texture: 'coily',    style: 'down', skin: 'deep' },
  { key: 'm_medium_dark_straight_brown', gender: 'm', length: 'medium', color: 'black',       texture: 'straight', style: 'down', skin: 'medium' },
  { key: 'm_medium_dark_curly_brown',    gender: 'm', length: 'medium', color: 'black',       texture: 'curly',    style: 'down', skin: 'medium' },
  { key: 'm_medium_brown_wavy_fair',     gender: 'm', length: 'medium', color: 'brown',       texture: 'wavy',     style: 'down', skin: 'fair' },
  { key: 'm_medium_blonde_wavy_pale',    gender: 'm', length: 'medium', color: 'blonde',      texture: 'wavy',     style: 'down', skin: 'pale' },
  { key: 'm_long_dark_straight_brown',   gender: 'm', length: 'long',   color: 'black',       texture: 'straight', style: 'down', skin: 'medium' },
  { key: 'm_man_bun_dark_brown',         gender: 'm', length: 'medium', color: 'black',       texture: 'straight', style: 'bun',  skin: 'medium' },
  { key: 'm_dreads_dark_deep',           gender: 'm', length: 'medium', color: 'black',       texture: 'coily',    style: 'locs', skin: 'deep' },
  { key: 'm_gray_short_pale',            gender: 'm', length: 'short',  color: 'gray',        texture: 'straight', style: 'down', skin: 'pale' },
  // Female (25)
  { key: 'f_pixie_dark_brown',           gender: 'f', length: 'short',  color: 'black',       texture: 'straight', style: 'down',   skin: 'medium' },
  { key: 'f_pixie_blonde_pale',          gender: 'f', length: 'short',  color: 'blonde',      texture: 'straight', style: 'down',   skin: 'pale' },
  { key: 'f_short_bob_dark_brown',       gender: 'f', length: 'short',  color: 'black',       texture: 'straight', style: 'down',   skin: 'medium' },
  { key: 'f_short_bob_blonde_pale',      gender: 'f', length: 'short',  color: 'blonde',      texture: 'straight', style: 'down',   skin: 'pale' },
  { key: 'f_short_dark_coily_deep',      gender: 'f', length: 'short',  color: 'black',       texture: 'coily',    style: 'down',   skin: 'deep' },
  { key: 'f_medium_dark_straight_brown', gender: 'f', length: 'medium', color: 'black',       texture: 'straight', style: 'down',   skin: 'medium' },
  { key: 'f_medium_dark_wavy_brown',     gender: 'f', length: 'medium', color: 'black',       texture: 'wavy',     style: 'down',   skin: 'medium' },
  { key: 'f_medium_dark_curly_brown',    gender: 'f', length: 'medium', color: 'black',       texture: 'curly',    style: 'down',   skin: 'medium' },
  { key: 'f_medium_brown_straight_fair', gender: 'f', length: 'medium', color: 'brown',       texture: 'straight', style: 'down',   skin: 'fair' },
  { key: 'f_medium_brown_wavy_fair',     gender: 'f', length: 'medium', color: 'brown',       texture: 'wavy',     style: 'down',   skin: 'fair' },
  { key: 'f_medium_blonde_straight_pale',gender: 'f', length: 'medium', color: 'blonde',      texture: 'straight', style: 'down',   skin: 'pale' },
  { key: 'f_medium_blonde_wavy_pale',    gender: 'f', length: 'medium', color: 'blonde',      texture: 'wavy',     style: 'down',   skin: 'pale' },
  { key: 'f_medium_red_wavy_pale',       gender: 'f', length: 'medium', color: 'red',         texture: 'wavy',     style: 'down',   skin: 'pale' },
  { key: 'f_long_black_straight_brown',  gender: 'f', length: 'long',   color: 'black',       texture: 'straight', style: 'down',   skin: 'medium' },
  { key: 'f_long_black_wavy_brown',      gender: 'f', length: 'long',   color: 'black',       texture: 'wavy',     style: 'down',   skin: 'medium' },
  { key: 'f_long_brown_straight_fair',   gender: 'f', length: 'long',   color: 'brown',       texture: 'straight', style: 'down',   skin: 'fair' },
  { key: 'f_long_brown_wavy_fair',       gender: 'f', length: 'long',   color: 'brown',       texture: 'wavy',     style: 'down',   skin: 'fair' },
  { key: 'f_long_blonde_straight_pale',  gender: 'f', length: 'long',   color: 'blonde',      texture: 'straight', style: 'down',   skin: 'pale' },
  { key: 'f_long_blonde_wavy_pale',      gender: 'f', length: 'long',   color: 'blonde',      texture: 'wavy',     style: 'down',   skin: 'pale' },
  { key: 'f_long_red_wavy_pale',         gender: 'f', length: 'long',   color: 'red',         texture: 'wavy',     style: 'down',   skin: 'pale' },
  { key: 'f_long_dark_coily_deep',       gender: 'f', length: 'long',   color: 'black',       texture: 'coily',    style: 'down',   skin: 'deep' },
  { key: 'f_braids_dark_deep',           gender: 'f', length: 'long',   color: 'black',       texture: 'coily',    style: 'braids', skin: 'deep' },
  { key: 'f_locs_dark_deep',             gender: 'f', length: 'long',   color: 'black',       texture: 'coily',    style: 'locs',   skin: 'deep' },
  { key: 'f_afro_dark_deep',             gender: 'f', length: 'medium', color: 'black',       texture: 'coily',    style: 'afro',   skin: 'deep' },
  { key: 'f_gray_medium_pale',           gender: 'f', length: 'medium', color: 'gray',        texture: 'straight', style: 'down',   skin: 'pale' },
];

// Bucket key → human-readable prompt fragment. Used to fill the {bucket_phrase}
// slot in image_templates (Flux+PuLID cosplay-image generation). Same source of
// truth as the Hunyuan stock-library curation plan
// ([[mainfeed_library_curation_plan]] §"Bucket key → Hunyuan prompt fragment").
const BUCKET_PROMPT_FRAGMENTS = {
  // Male (15)
  m_bald:                       'bald man with clean-shaven head',
  m_buzz_dark_med:               'man with very short buzz cut dark hair, medium-brown skin',
  m_buzz_light_fair:             'man with very short buzz cut, fair Caucasian skin',
  m_short_dark_straight_brown:   'man with short dark straight hair, medium-brown skin',
  m_short_dark_straight_fair:    'man with short dark straight hair, fair Caucasian skin',
  m_short_blonde_straight_pale:  'man with short blonde straight hair, pale Caucasian skin',
  m_short_dark_coily_deep:       'Black man with very short dark coily hair, deep skin',
  m_medium_dark_straight_brown:  'man with medium-length dark straight hair, medium-brown skin',
  m_medium_dark_curly_brown:     'man with medium-length dark curly hair, medium-brown skin',
  m_medium_brown_wavy_fair:      'man with medium-length brown wavy hair, fair Caucasian skin',
  m_medium_blonde_wavy_pale:     'man with medium-length blonde wavy hair, pale skin',
  m_long_dark_straight_brown:    'man with long dark straight hair past shoulders, medium-brown skin',
  m_man_bun_dark_brown:          'man with dark hair tied in a top bun, medium-brown skin',
  m_dreads_dark_deep:            'Black man with shoulder-length dreadlocks, deep skin',
  m_gray_short_pale:             'older man with short gray hair, pale fair skin',
  // Female (25)
  f_pixie_dark_brown:            'woman with pixie cut dark hair, medium-brown skin',
  f_pixie_blonde_pale:           'woman with pixie cut blonde hair, pale skin',
  f_short_bob_dark_brown:        'woman with short bob dark hair, medium-brown skin',
  f_short_bob_blonde_pale:       'woman with short bob blonde hair, pale skin',
  f_short_dark_coily_deep:       'Black woman with short natural coily dark hair, deep skin',
  f_medium_dark_straight_brown:  'woman with shoulder-length dark straight hair, medium-brown skin',
  f_medium_dark_wavy_brown:      'woman with shoulder-length dark wavy hair, medium-brown skin',
  f_medium_dark_curly_brown:     'woman with shoulder-length dark curly hair, medium-brown skin',
  f_medium_brown_straight_fair:  'woman with shoulder-length brown straight hair, fair Caucasian skin',
  f_medium_brown_wavy_fair:      'woman with shoulder-length brown wavy hair, fair Caucasian skin',
  f_medium_blonde_straight_pale: 'woman with shoulder-length blonde straight hair, pale skin',
  f_medium_blonde_wavy_pale:     'woman with shoulder-length blonde wavy hair, pale skin',
  f_medium_red_wavy_pale:        'redhead woman with shoulder-length red wavy hair, pale freckled skin',
  f_long_black_straight_brown:   'woman with long jet-black straight hair, medium-brown South Asian skin',
  f_long_black_wavy_brown:       'woman with long black wavy hair, medium-brown skin',
  f_long_brown_straight_fair:    'woman with long brown straight hair, fair Caucasian skin',
  f_long_brown_wavy_fair:        'woman with long brown wavy hair, fair Caucasian skin',
  f_long_blonde_straight_pale:   'woman with long blonde straight hair, pale skin',
  f_long_blonde_wavy_pale:       'woman with long blonde wavy hair, pale skin',
  f_long_red_wavy_pale:          'redhead woman with long red wavy hair, pale freckled skin',
  f_long_dark_coily_deep:        'Black woman with long natural coily 4C hair, deep skin',
  f_braids_dark_deep:            'Black woman with long cornrow braids, deep skin',
  f_locs_dark_deep:              'Black woman with long dreadlocks, deep skin',
  f_afro_dark_deep:              'Black woman with afro hairstyle, deep skin',
  f_gray_medium_pale:            'older woman with medium-length gray hair, pale skin',
};

function bucketPhrase(bucketKey) {
  // Fallback to a neutral phrase if the user hasn't been bucketed yet — keeps
  // image generation working before the appearance-classify task finishes.
  return BUCKET_PROMPT_FRAGMENTS[bucketKey] || 'a person';
}

const APPEARANCE_PROMPT = `You are classifying a person's appearance for face-swap library matching.
Look at the photo and return STRICT JSON (no prose, no markdown, no backticks) with these EXACT keys:

{
  "gender":        "m" | "f",
  "hair_length":   "bald" | "buzz" | "short" | "medium" | "long",
  "hair_color":    "black" | "dark_brown" | "brown" | "blonde" | "red" | "gray",
  "hair_texture":  "straight" | "wavy" | "curly" | "coily",
  "hair_style":    "down" | "bun" | "braids" | "locs" | "afro",
  "skin_tone":     "pale" | "fair" | "medium" | "brown" | "deep",
  "confidence":    0.0-1.0
}

Definitions:
- hair_length: bald = no hair, buzz = < 1cm clipper cut, short = 1-5cm, medium = chin-to-shoulder, long = past shoulder
- skin_tone: pale = very fair Northern European, fair = light Caucasian, medium = olive / South Asian / Latino, brown = brown South Asian or light Black, deep = dark Black skin
- hair_style: pick "down" unless the hair is clearly in a top-bun, braids/cornrows, locs/dreadlocks, or afro pick-out style
- For bald subjects, set hair_color/texture/style to a sensible default ("black"/"straight"/"down")

Output ONLY the JSON object. No extra text.`;

function _coerceAttr(attrs) {
  // Light normalization so the Llama output maps cleanly to the bucket table.
  const a = { ...attrs };
  a.gender = (a.gender || '').toLowerCase().startsWith('f') ? 'f' : 'm';
  a.hair_length  = String(a.hair_length  || 'medium').toLowerCase();
  a.hair_color   = String(a.hair_color   || 'black').toLowerCase().replace(/\s+/g, '_');
  a.hair_texture = String(a.hair_texture || 'straight').toLowerCase();
  a.hair_style   = String(a.hair_style   || 'down').toLowerCase();
  a.skin_tone    = String(a.skin_tone    || 'medium').toLowerCase();
  // Collapse hair_color: dark_brown→black, etc. (the bucket table only uses black/brown/blonde/red/gray)
  if (a.hair_color === 'dark_brown') a.hair_color = 'black';
  if (a.hair_color === 'jet_black' || a.hair_color === 'jet-black') a.hair_color = 'black';
  return a;
}

function _pickBucket(attrs) {
  const a = _coerceAttr(attrs);
  // Score each bucket against the attributes; higher = closer.
  // Gender mismatch = hard reject (filter first), then weighted match.
  const candidates = APPEARANCE_BUCKETS.filter(b => b.gender === a.gender);
  let best = null, bestScore = -1, bestExplain = '';
  for (const b of candidates) {
    let s = 0;
    const ex = [];
    if (b.length  === a.hair_length  || b.length  === 'any') { s += 3; } else if (
      // adjacent length penalty smaller
      (b.length === 'short' && (a.hair_length === 'buzz' || a.hair_length === 'medium')) ||
      (b.length === 'medium' && (a.hair_length === 'short' || a.hair_length === 'long')) ||
      (b.length === 'long' && a.hair_length === 'medium') ||
      (b.length === 'buzz' && a.hair_length === 'short') ||
      (b.length === 'bald' && a.hair_length === 'buzz')
    ) { s += 1; }
    if (b.color   === a.hair_color   || b.color   === 'any') s += 3;
    if (b.texture === a.hair_texture || b.texture === 'any') s += 2;
    if (b.style   === a.hair_style   || b.style   === 'any') s += 2;
    if (b.skin    === a.skin_tone    || b.skin    === 'any') { s += 4; } else if (
      // adjacent skin penalty smaller
      (b.skin === 'fair' && (a.skin_tone === 'pale' || a.skin_tone === 'medium')) ||
      (b.skin === 'medium' && (a.skin_tone === 'fair' || a.skin_tone === 'brown')) ||
      (b.skin === 'brown' && (a.skin_tone === 'medium' || a.skin_tone === 'deep')) ||
      (b.skin === 'deep' && a.skin_tone === 'brown') ||
      (b.skin === 'pale' && a.skin_tone === 'fair')
    ) { s += 1.5; }
    if (s > bestScore) { bestScore = s; best = b; bestExplain = ex.join(','); }
  }
  return { bucket: best ? best.key : null, score: bestScore };
}

// POST /api/admin/detect-appearance
// Body (JSON): one of:
//   { selfie_r2_key: "stock/test_selfie.jpg",  selfie_r2_bucket?: "STOCK" | "SELFIES" }
//   { selfie_url:    "https://...external-jpg..." }
// Returns: { ok, attributes: {gender, hair_length, ...}, bucket, score, raw }
async function handleAdminDetectAppearance(request, env, origin) {
  try {
    return await _detectAppearanceInner(request, env, origin);
  } catch (err) {
    // Log the stack server-side (visible via `wrangler tail`) so debugging
    // still works, but DON'T return it in the response. Even though this is
    // an admin-only endpoint, info-disclosure of internal paths/symbols is
    // unnecessary — the response carries enough for the admin to react.
    console.error('[detect-appearance] exception', err && err.stack ? err.stack : String(err));
    return errResp('detect_appearance_exception', 500, origin, {
      detail: String(err).slice(0, 600),
    });
  }
}
async function _detectAppearanceInner(request, env, origin) {
  if (!checkAdmin(request, env)) return errResp('unauthorized', 401, origin);
  if (!env.AI) return errResp('ai_binding_missing', 500, origin);
  const body = await request.json().catch(() => ({}));

  // Source priority: R2 binding (preferred — no self-fetch issues) > external URL
  let imageBytes;
  const r2Key = typeof body.selfie_r2_key === 'string' ? body.selfie_r2_key : '';
  const r2BucketName = String(body.selfie_r2_bucket || 'STOCK').toUpperCase();
  const selfieUrl = String(body.selfie_url || '').trim();

  if (r2Key) {
    const bucket = env[r2BucketName] || env.STOCK;
    if (!bucket) return errResp('r2_bucket_binding_missing', 500, origin, { bucket: r2BucketName });
    const obj = await bucket.get(r2Key);
    if (!obj) return errResp('selfie_not_found', 404, origin, { r2_key: r2Key, r2_bucket: r2BucketName });
    imageBytes = new Uint8Array(await obj.arrayBuffer());
  } else if (selfieUrl) {
    try {
      const r = await fetch(selfieUrl);
      if (!r.ok) return errResp('selfie_fetch_failed', 502, origin, { status: r.status });
      imageBytes = new Uint8Array(await r.arrayBuffer());
    } catch (err) {
      return errResp('selfie_fetch_exception', 502, origin, { detail: String(err).slice(0, 400) });
    }
  } else {
    return errResp('missing_selfie_source', 400, origin, { hint: 'provide selfie_r2_key (preferred) or selfie_url' });
  }

  // Call Llama 3.2 Vision (auto-accept license on first use)
  let aiResp;
  const aiArgs = {
    prompt: APPEARANCE_PROMPT,
    image: [...imageBytes],
    max_tokens: 256,
  };
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', aiArgs);
  } catch (err) {
    const msg = String(err).slice(0, 800);
    if (msg.includes("5016") || msg.toLowerCase().includes("must submit the prompt 'agree'")) {
      try {
        await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
        aiResp = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', aiArgs);
      } catch (err2) {
        return errResp('ai_call_exception_after_agree', 500, origin, { detail: String(err2).slice(0, 400) });
      }
    } else {
      return errResp('ai_call_exception', 500, origin, { detail: msg });
    }
  }

  // Workers AI Llama 3.2 Vision typically returns:
  //   { response: <object or string>, tool_calls: [...], usage: {...} }
  // The model is JSON-mode aware, so .response is often already the parsed
  // attribute object. Fall through to string-parsing if not.
  let attrs = null;
  if (aiResp && typeof aiResp === 'object') {
    if (aiResp.response && typeof aiResp.response === 'object') {
      attrs = aiResp.response;
    } else {
      const candidate = (typeof aiResp.response === 'string' ? aiResp.response
                        : typeof aiResp.result === 'string' ? aiResp.result
                        : '').trim();
      if (candidate) {
        const m = candidate.match(/\{[\s\S]*\}/);
        if (m) { try { attrs = JSON.parse(m[0]); } catch (_) {} }
      }
    }
  }
  if (!attrs || !attrs.gender) {
    return json({
      ok: false,
      error: 'ai_parse_failed',
      raw: JSON.stringify(aiResp).slice(0, 1500),
    }, {}, origin);
  }

  // Optional gender override (signup may know the gender already and Llama mis-classifies hairstyle)
  if (body.gender === 'm' || body.gender === 'f') attrs.gender = body.gender;

  const { bucket, score } = _pickBucket(attrs);

  return json({
    ok: true,
    attributes: attrs,
    bucket,
    score,
  }, {}, origin);
}
