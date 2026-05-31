// Mainfeed — main app (feed + download/share with caption baked on top)

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.mainfeed.app';

const $ = (q) => document.querySelector(q);

const ERROR_MESSAGES = {
  not_authenticated: 'Session expired. Logging out…',
};

function showError(code) {
  if (code === 'not_authenticated') {
    window.location.href = '/login.html';
    return;
  }
  alert(ERROR_MESSAGES[code] || `Something went wrong (${code || 'unknown'}).`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Boot
let currentUser = null;
(async function boot() {
  try {
    const meRes = await fetch(`${API}/api/me`, { credentials: 'include' });
    if (!meRes.ok) {
      window.location.href = '/login.html';
      return;
    }
    const me = await meRes.json();
    currentUser = me.user;
    paintMe(currentUser);
    await loadDays();
  } catch (err) {
    console.error('boot error', err);
    window.location.href = '/login.html';
  }
})();

function paintMe(user) {
  const menuInitial = $('#mf-app-menu-initial');
  if (menuInitial && user?.handle) menuInitial.textContent = user.handle.charAt(0).toUpperCase();
  const menuHandle = $('#mf-app-menu-handle');
  if (menuHandle && user?.handle) menuHandle.textContent = '@' + user.handle;
  const menuEmail = $('#mf-app-menu-email');
  if (menuEmail && user?.email) menuEmail.textContent = user.email;
  const publicLink = $('#mf-menu-public-profile');
  if (publicLink && user?.handle) publicLink.href = '/@' + user.handle;
  // Show the "Verify your account" menu item only for unverified users.
  const verifyItem = $('#mf-menu-verify-item');
  if (verifyItem) verifyItem.hidden = !!user?.verified;
}

// ============ Header scroll behavior ============
// At top of feed: solid black header (defined in CSS). Once user starts
// scrolling, switch to .--scrolled which makes the bar transparent and
// gives the brand + hamburger pills their floating backdrop-blur look.
(function wireHeaderScroll() {
  const headerEl = document.querySelector('.mf-app-header');
  if (!headerEl) return;
  let scrolled = false;
  const update = () => {
    const isScrolled = window.scrollY > 10;
    if (isScrolled !== scrolled) {
      scrolled = isScrolled;
      headerEl.classList.toggle('mf-app-header--scrolled', scrolled);
    }
  };
  window.addEventListener('scroll', update, { passive: true });
  update();  // initialize on load
})();

// ============ App menu drawer (logout etc.) ============

const appMenuToggle = $('#mf-app-menu-toggle');
const appMenu = $('#mf-app-menu');
const appMenuClose = $('#mf-app-menu-close');
appMenuToggle?.addEventListener('click', () => { if (appMenu) appMenu.hidden = false; });
appMenuClose?.addEventListener('click', () => { if (appMenu) appMenu.hidden = true; });
appMenu?.addEventListener('click', (e) => {
  if (e.target === appMenu) appMenu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && appMenu && !appMenu.hidden) appMenu.hidden = true;
});

$('#mf-menu-logout')?.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await fetch(`${API}/api/logout`, { method: 'POST', credentials: 'include' });
  } catch {}
  window.location.href = '/';
});

// ============ Storytime feed (arc → day list → day view) ============

let _sagaPollTimer = null;
let _openDay = null;      // null = day-list view; N = viewing day N
let _shareName = 'LOST';
// Day view: Story (one piece, 30s auto-advance) vs Feed (scrollable 1→N).
let _dayPieces = [];
let _dayNum = null;
let _view = 'feed';        // 'feed' | 'story'  (default Feed = the existing scroll view)
let _storyIndex = 0;
let _storyTimer = null;
const STORY_MS = 20000;    // each piece shows for 20s in Story view

async function loadDays() {
  const feed = $('#mf-feed');
  if (!feed) return;
  const res = await fetch(`${API}/api/saga/days`, { credentials: 'include' });
  if (res.status === 401) return showError('not_authenticated');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError(data.error);
  _shareName = data.share_name || 'LOST';
  renderDayList(data.days || []);

  // While Day 1 is still baking (nothing open yet), poll faster so it pops in
  // automatically when the pod finishes. Once a day is open, stop polling.
  if (_sagaPollTimer) clearTimeout(_sagaPollTimer);
  const anyOpen = (data.days || []).some((d) => d.open);
  if (_openDay === null && !anyOpen) _sagaPollTimer = setTimeout(loadDays, 8000);
}

function renderDayList(days) {
  const feed = $('#mf-feed');

  // No days yet → the saga is baking. Loading state.
  if (days.length === 0) {
    feed.innerHTML = `
      <div class="mf-saga-loading">
        <div class="mf-saga-spinner"></div>
        <h2>Your story is being created…</h2>
        <p>Episode 1 of <b>${escapeHtml(_shareName)}</b> is rendering. This takes a few minutes — it will appear here on its own.</p>
        <div class="mf-saga-progress"><div class="mf-saga-progress-bar"></div></div>
      </div>`;
    return;
  }

  const currentDay = (days.filter((d) => d.open).reduce((m, d) => Math.max(m, d.day), 0)) || 1;
  feed.innerHTML = `
    <section class="mf-hero" aria-label="Your story">
      <div class="mf-hero-inner">
        <p class="mf-hero-line" id="mf-hero-line"></p>
      </div>
    </section>
    <div class="mf-eplist">${days.map(dayRow).join('')}</div>`;
  startHeroRotator(currentDay);
}

// Hero card: cycle the welcome lines with a slow fade in/out. Self-stops when
// the feed re-renders (the #mf-hero-line node leaves the DOM).
let _heroTimer = null;
function heroLines(currentDay) {
  const h = (currentUser && currentUser.handle) ? '@' + currentUser.handle : 'there';
  const n = currentDay;
  return [
    `Hi <span class="mf-hero-em">${escapeHtml(h)}</span>!`,
    `Your story is now <span class="mf-hero-em">${n} episode${n === 1 ? '' : 's'}</span> in.`,
    `You are now in the <span class="mf-hero-em">${escapeHtml(_shareName)}</span> saga.`,
    `After 30 episodes, a new saga begins — <span class="mf-hero-em">starring you</span>.`,
  ];
}
function startHeroRotator(currentDay) {
  if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
  const el = $('#mf-hero-line');
  if (!el) return;
  const lines = heroLines(currentDay);
  let i = 0;
  const show = () => {
    if (!el.isConnected) { clearInterval(_heroTimer); _heroTimer = null; return; }
    el.innerHTML = lines[i % lines.length];
    el.classList.add('mf-hero-line--in');
    setTimeout(() => { if (el.isConnected) el.classList.remove('mf-hero-line--in'); }, 3700);
    i++;
  };
  show();
  _heroTimer = setInterval(show, 5400);
}

function dayRow(d) {
  const locked = !d.open;
  const right = locked
    ? `<span class="mf-ep-icon mf-ep-icon--lock" aria-hidden="true">🔒</span>`
    : `<span class="mf-ep-icon mf-ep-icon--play" aria-hidden="true">▶</span>`;
  // "Day N : Episode title" — no piece count. Locked future chapters show a hint.
  const title = d.title ? `Episode ${d.day} : ${escapeHtml(d.title)}` : `Episode ${d.day}`;
  const meta = locked ? (d.ready > 0 ? 'Available soon' : 'Locked') : '';
  // Per-day background image arrives later; render the (empty) layer now so
  // dropping in d.bg_image is a one-line change.
  const bg = d.bg_image ? ` style="background-image:url('${encodeURI(d.bg_image)}')"` : '';
  return `
    <button class="mf-ep${locked ? ' mf-ep--locked' : ''}" data-day="${d.day}" ${locked ? 'disabled' : ''}>
      <span class="mf-ep-bg"${bg} aria-hidden="true"></span>
      <span class="mf-ep-num">${d.day}</span>
      <span class="mf-ep-body">
        <span class="mf-ep-title">${title}</span>
        ${meta ? `<span class="mf-ep-meta">${meta}</span>` : ''}
      </span>
      ${right}
    </button>`;
}

async function openDay(day) {
  _openDay = day;
  if (_sagaPollTimer) { clearTimeout(_sagaPollTimer); _sagaPollTimer = null; }
  const feed = $('#mf-feed');
  feed.innerHTML = `<div class="mf-day-loading">Loading Episode ${day}…</div>`;
  const res = await fetch(`${API}/api/saga/day?n=${day}`, { credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError(data.error);
  renderDayView(day, data.pieces || []);
  window.scrollTo(0, 0);
}

function renderDayView(day, pieces) {
  _dayPieces = pieces;
  _dayNum = day;
  _storyIndex = 0;
  const feed = $('#mf-feed');
  feed.innerHTML = `
    <div class="mf-day-head">
      <button class="mf-day-back" data-day-back>‹ All episodes</button>
      <div class="mf-day-title">${escapeHtml(_shareName)} · EPISODE ${day}</div>
    </div>
    <div class="mf-viewtoggle" role="tablist">
      <button class="mf-viewtoggle-btn" data-view="story" role="tab">▶ Story view</button>
      <button class="mf-viewtoggle-btn" data-view="feed" role="tab">☰ Feed view</button>
    </div>
    <div class="mf-view-container"></div>`;
  renderView();
}

// Render whichever view is active into .mf-view-container + sync the toggle.
function renderView() {
  const c = $('.mf-view-container');
  if (!c) return;
  document.querySelectorAll('.mf-viewtoggle-btn').forEach((b) =>
    b.classList.toggle('mf-viewtoggle-btn--active', b.dataset.view === _view));
  stopStory();
  if (_view === 'story') { renderStory(); return; }
  c.innerHTML = `<div class="mf-day-pieces">${_dayPieces.map((p, i) => pieceCard(p, i, _dayPieces.length)).join('')}</div>`;
}

function setView(v) {
  if (v === _view || (v !== 'story' && v !== 'feed')) return;
  _view = v;
  renderView();
}

// ---- Story view: one piece at a time, 30s each, auto-advance, smooth fades ----
function renderStory() {
  const c = $('.mf-view-container');
  if (!c) return;
  _storyIndex = Math.max(0, Math.min(_storyIndex, _dayPieces.length - 1));
  const p = _dayPieces[_storyIndex];
  if (!p) { c.innerHTML = ''; return; }
  const total = _dayPieces.length;
  const media = p.type === 'image'
    ? `<img class="mf-story-media" src="${API}${p.file_url}" alt="" crossorigin="use-credentials" />`
    : `<video class="mf-story-media" src="${API}${p.file_url}" muted loop playsinline autoplay></video>`;
  const caption = String(p.caption || '').trim();
  c.innerHTML = `
    <div class="mf-story">
      <div class="mf-story-stage">
        ${media}
        <span class="mf-piece-num">${_storyIndex + 1}<span class="mf-piece-num-sep">/</span>${total}</span>
      </div>
      ${caption ? `<p class="mf-story-caption">${escapeHtml(caption)}</p>` : ''}
      <div class="mf-story-progress"><div class="mf-story-progress-bar"></div></div>
      <div class="mf-story-nav">
        <button class="mf-story-btn" data-story-nav="back" ${_storyIndex === 0 ? 'disabled' : ''}>‹ Back</button>
        <button class="mf-story-btn" data-story-nav="next" ${_storyIndex >= total - 1 ? 'disabled' : ''}>Next ›</button>
      </div>
    </div>`;
  startStoryTimer();
}

// Animate the 30s progress bar, then auto-advance (stops on the last piece).
function startStoryTimer() {
  stopStory();
  const bar = $('.mf-story-progress-bar');
  if (bar) {
    bar.style.transition = 'none';
    bar.style.width = '0%';
    void bar.offsetWidth;                       // reflow so 0% sticks before animating
    bar.style.transition = `width ${STORY_MS}ms linear`;
    bar.style.width = '100%';
  }
  _storyTimer = setTimeout(() => {
    if (_storyIndex < _dayPieces.length - 1) storyGo(_storyIndex + 1);
  }, STORY_MS);
}

function stopStory() {
  if (_storyTimer) { clearTimeout(_storyTimer); _storyTimer = null; }
}

// Fade the current piece out, swap to idx, fade the new one in (CSS handles both).
function storyGo(idx) {
  if (idx < 0 || idx >= _dayPieces.length) return;
  stopStory();
  const story = $('.mf-story');
  if (story) {
    story.classList.add('mf-story--fading');
    setTimeout(() => { _storyIndex = idx; renderStory(); }, 280);
  } else {
    _storyIndex = idx;
    renderStory();
  }
}

function pieceCard(p, i, total) {
  const isImage = p.type === 'image';
  const media = isImage
    ? `<img class="mf-piece-media" src="${API}${p.file_url}" alt="" crossorigin="use-credentials" />`
    : `<video class="mf-piece-media" src="${API}${p.file_url}" muted loop playsinline autoplay></video>`;
  const caption = String(p.caption || '').trim();
  // Subtle 1→N sequence counter (Instagram-carousel style), top-right of the stage,
  // so each chapter reads beginning→end.
  const num = (Number.isInteger(i) && Number.isInteger(total))
    ? `<span class="mf-piece-num">${i + 1}<span class="mf-piece-num-sep">/</span>${total}</span>` : '';
  // Clean media in-feed (no burned bug). The monologue is in-app caption text.
  return `
    <article class="mf-piece" data-id="${p.id}" data-type="${p.type}" data-url="${API}${p.file_url}">
      <div class="mf-piece-stage">${media}${num}</div>
      ${caption ? `<p class="mf-piece-caption">${escapeHtml(caption)}</p>` : ''}
      <div class="mf-piece-actions">
        <button class="mf-piece-action" data-piece-action="download" data-id="${p.id}">Download</button>
        <button class="mf-piece-action" data-piece-action="share" data-id="${p.id}">Share</button>
      </div>
    </article>`;
}

// Day navigation: open a day, or go back to the chapter list.
document.addEventListener('click', (e) => {
  const ep = e.target.closest('.mf-ep:not(.mf-ep--locked)');
  if (ep && ep.dataset.day) { openDay(parseInt(ep.dataset.day, 10)); return; }
  if (e.target.closest('[data-day-back]')) { stopStory(); _openDay = null; loadDays(); return; }
  const vt = e.target.closest('[data-view]');
  if (vt) { setView(vt.dataset.view); return; }
  const sn = e.target.closest('[data-story-nav]');
  if (sn) { storyGo(_storyIndex + (sn.dataset.storyNav === 'next' ? 1 : -1)); return; }
});

// ============ Piece actions ============

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-piece-action]');
  if (!btn) return;
  const action = btn.dataset.pieceAction;
  const id = btn.dataset.id;
  const card = btn.closest('.mf-piece');
  if (action === 'download') return downloadPiece(id, card, btn);
  if (action === 'share') return sharePiece(id, card, btn);
  if (action === 'publish-toggle') return togglePublish(id, card, btn);
});

// Liveness gate. Any action that lets a face-swap leave the private feed
// — publish to /@handle, download to camera roll, share via Web Share API
// — requires verification. Returns true if user is (now) verified.
async function requireVerified() {
  if (currentUser?.verified) return true;
  return await runVerifyFlow();
}

async function togglePublish(id, card, btn) {
  const isPublic = card.dataset.public === '1';
  // Going public requires liveness verification. Unpublish is always allowed.
  if (!isPublic && !(await requireVerified())) return;
  setBusy(btn, isPublic ? 'Unpublishing…' : 'Publishing…');
  try {
    const res = await fetch(`${API}/api/piece/${id}/${isPublic ? 'unpublish' : 'publish'}`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Server-side belt-and-suspenders for the verify gate: if for any
      // reason the local state was stale, refresh user + re-open verify.
      if (data.error === 'verification_required') {
        await refreshMe();
        const ok = await runVerifyFlow();
        if (ok) return togglePublish(id, card, btn);
        return;
      }
      alert('Failed: ' + (data.error || 'unknown'));
      return;
    }
    const nowPublic = !isPublic;
    card.dataset.public = nowPublic ? '1' : '0';
    btn.textContent = nowPublic ? 'Unpublish' : 'Publish';
    btn.classList.toggle('mf-piece-action--active', nowPublic);
    if (nowPublic) {
      showToast(`Live at mainfeed.app/@${currentUser?.handle || ''}`);
    }
  } finally {
    setBusy(btn, null);
  }
}

async function refreshMe() {
  try {
    const res = await fetch(`${API}/api/me`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      paintMe(currentUser);
    }
  } catch (_) {}
}

function showToast(msg) {
  let toast = document.getElementById('mf-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'mf-toast';
    toast.style.cssText = `
      position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
      background: var(--surface); border: 1px solid var(--border); color: var(--text);
      padding: 12px 18px; border-radius: 999px; font-size: 14px; font-weight: 600;
      z-index: 200; box-shadow: 0 8px 28px rgba(0,0,0,0.5);
      animation: mf-toast-in 0.2s ease;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(window.__mfToastTimer);
  window.__mfToastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
  }, 2500);
}

async function downloadPiece(id, card, btn) {
  // Downloaded files end up on TikTok/IG/etc. — same likeness-leaves-the-app
  // risk as Publish, so we gate behind verification too.
  if (!(await requireVerified())) return;
  setBusy(btn, 'Baking…');
  try {
    const blob = await renderPieceWithCaption(card);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mainfeed-${id}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    console.error('download failed', err);
    alert('Download failed. Try again.');
  } finally {
    setBusy(btn, null);
  }
}

async function sharePiece(id, card, btn) {
  // Web Share API hands the file straight to other apps — same as Download.
  if (!(await requireVerified())) return;
  setBusy(btn, 'Preparing…');
  try {
    const blob = await renderPieceWithCaption(card);
    const file = new File([blob], `mainfeed-${id}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: 'Made on Mainfeed.app' });
    } else if (navigator.share) {
      await navigator.share({ title: 'Mainfeed', text: 'Made on Mainfeed.app' });
    } else {
      alert('Share not supported on this browser. Use Download instead.');
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      console.error('share failed', err);
      alert('Share failed. Try Download instead.');
    }
  } finally {
    setBusy(btn, null);
  }
}

function setBusy(btn, label) {
  if (!btn) return;
  if (label) {
    if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.origLabel || btn.textContent;
    btn.disabled = false;
  }
}

// ============ Caption baking on a canvas (download + share) ============

async function loadImageBlob(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('image fetch failed');
  return await res.blob();
}

async function renderPieceWithCaption(card) {
  const url = card.dataset.url;
  const caption = (card.dataset.caption || '').trim();
  const blob = await loadImageBlob(url);
  const imgBitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = imgBitmap.width;
  canvas.height = imgBitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgBitmap, 0, 0);

  if (caption) drawCaptionTop(ctx, canvas.width, canvas.height, caption);
  drawWatermark(ctx, canvas.width, canvas.height, `Mainfeed.app · @${currentUser?.handle || ''}`);

  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
  );
}

function drawCaptionTop(ctx, w, h, text) {
  const fontSize = Math.round(h * 0.06);
  const padding = Math.round(w * 0.05);
  const maxWidth = w - padding * 2;
  ctx.font = `bold ${fontSize}px Impact, "Anton", "Arial Black", sans-serif`;
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = Math.max(2, fontSize * 0.08);
  ctx.lineJoin = 'round';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  drawWrappedText(ctx, text.toUpperCase(), w / 2, padding, maxWidth, fontSize * 1.1);
}

function drawWrappedText(ctx, text, x, startY, maxWidth, lineHeight) {
  const lines = wrapLines(ctx, text, maxWidth);
  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawWatermark(ctx, w, h, text) {
  const fontSize = Math.max(11, Math.round(h * 0.018));
  ctx.font = `600 ${fontSize}px -apple-system, "SF Pro Text", system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  const padX = Math.max(10, Math.round(w * 0.015));
  const padY = Math.max(10, Math.round(h * 0.015));
  ctx.strokeText(text, w - padX, h - padY);
  ctx.fillText(text, w - padX, h - padY);
}

// ============ Verify-account flow (10-sec record + face check + upload) ============
// Lazy-loaded MediaPipe BlazeFace detector — same model as signup used to use.
let _verifyDetector = null;
let _verifyDetectorPromise = null;
async function getVerifyDetector() {
  if (_verifyDetector) return _verifyDetector;
  if (_verifyDetectorPromise) return _verifyDetectorPromise;
  _verifyDetectorPromise = (async () => {
    const mod = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs');
    const { FaceDetector, FilesetResolver } = mod;
    const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm');
    _verifyDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    });
    return _verifyDetector;
  })();
  return _verifyDetectorPromise;
}

// Opens the verify modal and resolves to `true` if the user successfully
// records + uploads the verification video, `false` if they bail.
async function runVerifyFlow() {
  const modal = $('#mf-verify-modal');
  const panelIntro = $('#mf-verify-panel-intro');
  const panelBlocked = $('#mf-verify-panel-blocked');
  const panelRec = $('#mf-verify-panel-rec');
  const panelDone = $('#mf-verify-panel-done');
  const closeBtn = $('#mf-verify-close');
  const startBtn = $('#mf-verify-start');
  const retryBtn = $('#mf-verify-retry');
  const doneCloseBtn = $('#mf-verify-done-close');
  const video = $('#mf-verify-video');
  const hint = $('#mf-verify-hint');
  const countdown = $('#mf-verify-countdown');
  const badge = $('#mf-verify-badge');
  const doneTitle = $('#mf-verify-done-title');
  const doneMsg = $('#mf-verify-done-msg');

  return new Promise((resolve) => {
    let resolved = false;
    let stream = null;
    let recorder = null;
    let recTimer = null;
    let faceSampleTimer = null;
    let faceSampleStats = { total: 0, withFace: 0 };

    function showPanel(name) {
      panelIntro.hidden = name !== 'intro';
      panelBlocked.hidden = name !== 'blocked';
      panelRec.hidden = name !== 'rec';
      panelDone.hidden = name !== 'done';
    }

    function cleanupStream() {
      if (recTimer) { clearInterval(recTimer); recTimer = null; }
      if (faceSampleTimer) { clearInterval(faceSampleTimer); faceSampleTimer = null; }
      try { recorder && recorder.state !== 'inactive' && recorder.stop(); } catch (_) {}
      recorder = null;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      video.srcObject = null;
    }

    function closeModal(success) {
      if (resolved) return;
      resolved = true;
      cleanupStream();
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      resolve(!!success);
    }

    function showBlocked() {
      const isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      const stepsEl = $('#mf-verify-blocked-steps');
      stepsEl.innerHTML = isStandalone
        ? `<li>Open <b>mainfeed.app</b> in <b>Chrome</b> (not this installed app)</li>
           <li>Tap the <b>🔒 lock icon</b> at the LEFT of the address bar</li>
           <li>Tap <b>Permissions</b> → <b>Camera</b> → <b>Allow</b></li>
           <li>Come back here and tap <b>Try again</b></li>`
        : `<li>Tap the <b>🔒 lock icon</b> at the LEFT of the address bar</li>
           <li>Tap <b>Permissions</b> → <b>Camera</b></li>
           <li>Change <b>Block</b> → <b>Allow</b></li>
           <li>Tap <b>Try again</b> below</li>`;
      showPanel('blocked');
    }

    async function startRecording() {
      showPanel('rec');
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 1280 } },
          audio: false,
        });
      } catch (err) {
        const name = (err && err.name) || 'unknown';
        if (name === 'NotAllowedError' || name === 'SecurityError') return showBlocked();
        alert(`Camera unavailable (${name}). Reload and try again.`);
        showPanel('intro');
        return;
      }
      video.srcObject = stream;
      try { await video.play(); } catch (_) {}
      hint.hidden = false;
      hint.textContent = 'Get ready…';
      countdown.hidden = false;
      countdown.classList.remove('mf-cam-countdown--rec');
      badge.hidden = true;

      // 3-2-1 pre-countdown
      for (let pre = 3; pre > 0; pre--) {
        countdown.textContent = pre;
        await new Promise((r) => setTimeout(r, 1000));
        if (resolved) return;
      }

      hint.hidden = true;
      badge.hidden = false;
      countdown.classList.add('mf-cam-countdown--rec');

      const chunks = [];
      const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      let mime = '';
      for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) { mime = c; break; }
      try {
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch (err) {
        alert('This browser cannot record video. Open Mainfeed in Chrome and try again.');
        cleanupStream();
        showPanel('intro');
        return;
      }
      recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); });
      recorder.addEventListener('stop', async () => {
        const blob = new Blob(chunks, { type: mime || 'video/webm' });
        const stats = { ...faceSampleStats };
        cleanupStream();
        if (stats.withFace < 1) {
          alert("We couldn't find your face in the recording. Try again with your face clearly in frame.");
          showPanel('intro');
          return;
        }
        // Upload to /api/verify-identity
        showPanel('done');
        doneTitle.textContent = 'Uploading…';
        doneMsg.textContent = 'Saving your verification video.';
        try {
          const ext = mime && mime.includes('mp4') ? 'mp4' : mime && mime.includes('webm') ? 'webm' : 'mp4';
          const fd = new FormData();
          fd.append('liveness_video', blob, `liveness.${ext}`);
          const res = await fetch(`${API}/api/verify-identity`, {
            method: 'POST',
            body: fd,
            credentials: 'include',
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            doneTitle.textContent = '❌ Verification failed';
            doneMsg.textContent = `Couldn't save (${data.error || res.status}). Tap Close and try again.`;
            doneCloseBtn.textContent = 'Close';
            return;
          }
          doneTitle.textContent = '✓ Verified';
          doneMsg.textContent = 'Your account is verified — you can publish to your public profile now.';
          await refreshMe();
          doneCloseBtn.textContent = 'Continue';
          // Mark this run as successful — closing the modal will resolve true.
          doneCloseBtn.dataset.success = '1';
        } catch (err) {
          doneTitle.textContent = '❌ Network error';
          doneMsg.textContent = 'Check your connection and try again.';
        }
      });
      recorder.start();

      // Live face sampling every 1.2s — same approach as signup used.
      faceSampleStats = { total: 0, withFace: 0 };
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      faceSampleTimer = setInterval(async () => {
        if (!video.videoWidth) return;
        try {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const detector = await getVerifyDetector();
          const r = detector.detect(canvas);
          faceSampleStats.total += 1;
          if (r.detections.length > 0) faceSampleStats.withFace += 1;
        } catch (_) {}
      }, 1200);

      // 10-sec countdown then auto-stop
      let left = 10;
      countdown.textContent = left;
      recTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(recTimer); recTimer = null;
          countdown.textContent = '0';
          try { recorder.stop(); } catch (_) {}
        } else {
          countdown.textContent = left;
        }
      }, 1000);
    }

    // Wire local listeners (re-bound each open; we tear them down on close)
    const onClose = () => closeModal(doneCloseBtn.dataset.success === '1');
    const onStart = () => startRecording();
    const onRetry = () => startRecording();
    const onDoneClose = () => closeModal(doneCloseBtn.dataset.success === '1');

    closeBtn.addEventListener('click', onClose, { once: true });
    startBtn.addEventListener('click', onStart, { once: true });
    retryBtn.addEventListener('click', onRetry, { once: true });
    doneCloseBtn.addEventListener('click', onDoneClose, { once: true });

    // Reset state + open
    doneCloseBtn.dataset.success = '';
    doneCloseBtn.textContent = 'Close';
    showPanel('intro');
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  });
}

// Wire "Verify your account" menu link
$('#mf-menu-verify')?.addEventListener('click', async (e) => {
  e.preventDefault();
  if (appMenu) appMenu.hidden = true;
  await runVerifyFlow();
});

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
