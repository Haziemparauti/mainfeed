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
let _openDay = null;      // null = day-list view; N = viewing episode N
let _shareName = 'LOST';
// Episode view = ONE continuous video. Segments (intro, swap clips, text cards,
// final card) play back-to-back; each plays its full length, then auto-advances
// on `ended`. No toggle, no per-piece timer — it just plays start→finish.
let _dayPieces = [];
let _dayNum = null;
let _segIndex = 0;         // which segment is on screen
let _playerMuted = false;  // flips true only if autoplay-with-sound is blocked

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
  _segIndex = 0;
  const feed = $('#mf-feed');
  feed.innerHTML = `
    <div class="mf-day-head">
      <button class="mf-day-back" data-day-back>‹ All episodes</button>
      <div class="mf-day-title">${escapeHtml(_shareName)} · EPISODE ${day}</div>
    </div>
    <div class="mf-player" id="mf-player">
      <div class="mf-player-stage">
        <video class="mf-player-video" id="mf-pv" playsinline preload="auto"></video>
        <button class="mf-player-unmute" id="mf-pv-unmute" type="button" hidden>🔊 Tap for sound</button>
        <div class="mf-player-overlay" id="mf-pv-overlay" hidden>
          <button class="mf-player-act" data-piece-action="download" type="button" aria-label="Save video">
            <svg class="mf-player-act-ic" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>
            <span class="mf-act-label">Save</span>
          </button>
          <button class="mf-player-act" data-piece-action="share" type="button" aria-label="Share video">
            <svg class="mf-player-act-ic" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5"/></svg>
            <span class="mf-act-label">Share</span>
          </button>
        </div>
      </div>
    </div>`;
  if (!pieces.length) {
    $('#mf-player').innerHTML = `<div class="mf-day-loading">This episode is still rendering…</div>`;
    return;
  }
  playSegment(0);
}

// A segment is shareable footage (the swap clips) — vs story furniture (intro,
// text cards, final card) which plays but can't leave the app. The worker tags
// each piece with `segment`; older rows fall back to "any non-image = footage".
function isVideoSegment(p) {
  if (p && p.segment) return p.segment === 'video';
  return !!p && p.type !== 'image';
}

// Render + autoplay segment idx into the single persistent <video>. Reusing one
// element keeps the audio "unlocked" state across the whole episode, so the cut
// between segments is seamless (the in/out fades are baked into the mp4s).
function playSegment(idx) {
  if (idx < 0 || idx >= _dayPieces.length) return;
  _segIndex = idx;
  const p = _dayPieces[idx];
  const v = $('#mf-pv');
  if (!v) return;
  const stage = v.closest('.mf-player-stage');
  const overlay = $('#mf-pv-overlay');
  const last = idx >= _dayPieces.length - 1;

  // Stage carries the current piece's identity for the Save/Share buttons.
  if (stage) {
    stage.dataset.id = p.id;
    stage.dataset.type = p.type || '';
    stage.dataset.url = `${API}${p.file_url}`;
    stage.dataset.export = `${API}${p.export_url || p.file_url}`;  // watermarked copy when present
  }
  // Save/Share live ON the video — only for shareable footage, never on cards.
  if (overlay) overlay.hidden = !isVideoSegment(p);

  v.src = `${API}${p.file_url}`;
  v.muted = _playerMuted;
  v.play().catch(() => {
    // Autoplay-with-sound blocked (no media engagement yet) → play muted and
    // surface a one-tap unmute. Once tapped, the rest of the episode has sound.
    _playerMuted = true;
    v.muted = true;
    v.play().catch(() => {});
    const u = $('#mf-pv-unmute'); if (u) u.hidden = false;
  });
  v.onended = () => { if (!last) playSegment(idx + 1); };
}

function stopPlayer() {
  const v = $('#mf-pv');
  if (v) { v.onended = null; try { v.pause(); } catch (_) {} }
}

// Episode navigation: open an episode, go back to the list, or unmute.
document.addEventListener('click', (e) => {
  const ep = e.target.closest('.mf-ep:not(.mf-ep--locked)');
  if (ep && ep.dataset.day) { openDay(parseInt(ep.dataset.day, 10)); return; }
  if (e.target.closest('[data-day-back]')) { stopPlayer(); _openDay = null; loadDays(); return; }
  const unmute = e.target.closest('#mf-pv-unmute');
  if (unmute) {
    _playerMuted = false;
    const v = $('#mf-pv');
    if (v) { v.muted = false; v.play().catch(() => {}); }
    unmute.hidden = true;
    return;
  }
});

// ============ Piece actions ============

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-piece-action]');
  if (!btn) return;
  const action = btn.dataset.pieceAction;
  const container = btn.closest('.mf-player-stage') || btn.closest('.mf-piece');
  if (!container) return;
  const id = btn.dataset.id || container.dataset.id;
  if (action === 'download') return downloadPiece(id, container, btn);
  if (action === 'share') return sharePiece(id, container, btn);
  if (action === 'publish-toggle') return togglePublish(id, container, btn);
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

// Each shareable clip is downloaded/shared as its branded mp4 — the context bug
// (logo + mainfeed.app/@handle + LOST · EPISODE N) is already burned into the
// `export` copy by the pod, so there's no client-side baking to do.
async function fetchBlob(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('fetch failed');
  return await res.blob();
}

async function downloadPiece(id, stage, btn) {
  // Downloaded files end up on TikTok/IG/etc. — same likeness-leaves-the-app
  // risk as Publish, so we gate behind verification too.
  if (!(await requireVerified())) return;
  setBusy(btn, 'Saving…');
  try {
    const blob = await fetchBlob(stage.dataset.export || stage.dataset.url);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mainfeed-${id}.mp4`;
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

async function sharePiece(id, stage, btn) {
  // Web Share API hands the file straight to other apps — same as Download.
  if (!(await requireVerified())) return;
  setBusy(btn, 'Preparing…');
  try {
    const blob = await fetchBlob(stage.dataset.export || stage.dataset.url);
    const file = new File([blob], `mainfeed-${id}.mp4`, { type: 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: 'Made on Mainfeed.app' });
    } else if (navigator.share) {
      await navigator.share({ title: 'Mainfeed', text: 'Made on Mainfeed.app' });
    } else {
      alert('Share not supported on this browser. Use Save instead.');
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      console.error('share failed', err);
      alert('Share failed. Try Save instead.');
    }
  } finally {
    setBusy(btn, null);
  }
}

function setBusy(btn, label) {
  if (!btn) return;
  // Overlay buttons are [icon][label] — swap only the label so the icon stays.
  const tgt = btn.querySelector('.mf-act-label') || btn;
  if (label) {
    if (!btn.dataset.origLabel) btn.dataset.origLabel = tgt.textContent;
    tgt.textContent = label;
    btn.disabled = true;
  } else {
    tgt.textContent = btn.dataset.origLabel || tgt.textContent;
    btn.disabled = false;
  }
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
