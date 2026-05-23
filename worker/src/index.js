// Mainfeed API worker — v0 backend
// Endpoints: signup, login, logout, me, feed, diary, piece file, piece delete

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
  const consentAge = form.get('consent_age') === 'true';
  const consentAi = form.get('consent_ai') === 'true';
  const consentTerms = form.get('consent_terms') === 'true';

  if (!isHandle(handle)) return errResp('invalid_handle', 400, origin);
  if (RESERVED_HANDLES.has(handle)) return errResp('reserved_handle', 400, origin);
  if (!isEmail(email)) return errResp('invalid_email', 400, origin);
  if (!isPassword(password)) return errResp('weak_password', 400, origin);
  if (!consentAge || !consentAi || !consentTerms) return errResp('consent_required', 400, origin);

  // Collect selfies
  const selfies = [];
  for (let i = 0; i < 10; i++) {
    const f = form.get(`selfie_${i}`);
    if (f && typeof f.arrayBuffer === 'function') selfies.push(f);
  }
  if (selfies.length < 5) return errResp('need_5_selfies', 400, origin);

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

  await env.DB.prepare(
    `INSERT INTO users
       (id, handle, email, password_hash, created_at,
        liveness_verified, consent_18, consent_ai, consent_terms,
        selfies_count, plan, daily_pieces_count, daily_pieces_reset_at)
     VALUES (?, ?, ?, ?, ?, 0, 1, 1, 1, ?, 'free', 0, ?)`
  ).bind(userId, handle, email, passwordHash, ts, selfies.length, ts).run();

  // Upload selfies to R2
  for (let i = 0; i < selfies.length; i++) {
    const s = selfies[i];
    const ext = (s.type.split('/')[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
    const key = `selfies/${userId}/${i}.${ext}`;
    await env.SELFIES.put(key, s.stream(), {
      httpMetadata: { contentType: s.type },
    });
  }

  const session = await createSession(env, userId);

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
  return json(
    { ok: true, user: { id: r.session.user_id, handle: r.session.handle, email: r.session.email } },
    {}, origin
  );
}

// ============ Feed / Pieces ============

async function handleFeed(request, env, origin) {
  const r = await requireSession(request, env, origin);
  if (r.error) return r.error;

  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

  const rows = await env.DB.prepare(
    `SELECT id, type, caption, mime_type, width, height, duration, created_at
     FROM generated_pieces
     WHERE user_id = ? AND deleted_at IS NULL
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
  }));

  return json({ ok: true, pieces, total: pieces.length }, {}, origin);
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

// ============ Generation pipeline (Workers AI: Llama 3.1 + Flux Schnell) ============

// Caption-writing few-shot prompt — tuned for Gen-Z meme tone
const CAPTION_SYSTEM_PROMPT = `You write short, punchy meme captions for a personal AI feed. The user's name is {handle}. The user just wrote a diary entry about their day. Write ONE caption in the style of viral Gen-Z TikTok/Instagram meme captions about THEMSELVES, in 3rd person ("@{handle} ..." or "POV: @{handle} ...").

Rules:
- 4-15 words MAX
- Self-aware, witty, slightly chaotic
- No emojis, no hashtags, no quotes
- Funny > clever > profound
- Reference the diary content specifically
- Sound like a real human meme, not corporate copy

Examples:
diary: "just woke up at 4pm" -> "@sara waking up at 16:00 acting like she didn't have plans"
diary: "investing in crypto" -> "POV: @sara about to lose everything on a coin she found on twitter"
diary: "hate my colleague" -> "@sara plotting revenge against Kevin from accounting all afternoon"
diary: "broke and tired" -> "@sara checking her bank app for the 47th time today"
diary: "fell in love" -> "@sara writing his name in her notes app like a 13 year old"
diary: "ate too much" -> "@sara entering food coma like a pregnant cat in summer"

Output ONLY the caption text. No quotes, no explanation, no prefix.`;

// Image-prompt rewriter — turns the meme caption into a Flux-friendly visual prompt
const IMAGE_PROMPT_SYSTEM = `You turn a meme caption into a short visual prompt for an AI image generator (Flux Schnell). Output ONLY the visual description, no quotes, no explanation.

Rules:
- 10-30 words
- Describe the SCENE/MOOD that matches the caption
- One person doing the action, vivid setting, cinematic lighting
- No text in image, no letters, no logos, no real celebrities
- Slightly cinematic / dramatic / film-still style
- Examples:
  caption: "waking up at 16:00 acting like she didn't have plans" -> "person sprawled in messy bed at sunset, alarm clock showing 4pm, harsh afternoon light through closed blinds, exhausted expression, cinematic"
  caption: "about to lose everything on a coin she found on twitter" -> "young adult staring at glowing phone screen in dark room, sweaty forehead, panicked eyes, neon green and red chart reflections on face, dramatic"
  caption: "writing his name in her notes app like a 13 year old" -> "girl on bed kicking feet, phone screen filling frame, soft pink bedroom light, dreamy expression, golden hour"
`;

async function generateCaption(env, handle, diaryContent) {
  const system = CAPTION_SYSTEM_PROMPT.replace(/\{handle\}/g, handle);
  const res = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `diary: "${diaryContent.slice(0, 400)}" ->` },
    ],
    max_tokens: 60,
    temperature: 0.85,
  });
  let caption = (res?.response || '').trim();
  // Strip leading "->" if model echoed it, strip surrounding quotes
  caption = caption.replace(/^["'`]+|["'`]+$/g, '').replace(/^->\s*/, '').trim();
  // Hard cap to 200 chars
  return caption.slice(0, 200) || `@${handle} living that mainfeed life`;
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

async function generateOnePiece(env, userId, handle, diaryEntryId, diaryContent, ts, referenceImageDataUrl) {
  try {
    const caption = await generateCaption(env, handle, diaryContent);
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
  // Load reference selfie once and reuse for all 3 parallel pieces
  const selfieDataUrl = await getUserSelfieDataUrl(env, userId);

  const NUM_PIECES = 3;
  const tasks = [];
  for (let i = 0; i < NUM_PIECES; i++) {
    tasks.push(generateOnePiece(env, userId, handle, diaryEntryId, diaryContent, ts + i, selfieDataUrl));
  }
  const results = await Promise.all(tasks);
  const created = results.filter(Boolean);

  if (created.length > 0) {
    await env.DB.prepare(
      'UPDATE diary_entries SET pieces_generated = ?, moderation_status = ? WHERE id = ?'
    ).bind(created.length, 'approved', diaryEntryId).run();
  }

  return created;
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

export default {
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

    // Feed
    if (method === 'GET' && path === '/api/feed') return handleFeed(request, env, origin);

    // Piece (file stream, delete)
    const pieceFileMatch = path.match(/^\/api\/piece\/([A-Za-z0-9_-]+)\/file$/);
    if (method === 'GET' && pieceFileMatch) return handlePieceFile(request, env, origin, pieceFileMatch[1]);
    const pieceDeleteMatch = path.match(/^\/api\/piece\/([A-Za-z0-9_-]+)$/);
    if (method === 'DELETE' && pieceDeleteMatch) return handlePieceDelete(request, env, origin, pieceDeleteMatch[1]);

    // Diary
    if (method === 'POST' && path === '/api/diary/create') return handleDiaryCreate(request, env, origin);

    return errResp('not_found', 404, origin, { path });
  },
};
