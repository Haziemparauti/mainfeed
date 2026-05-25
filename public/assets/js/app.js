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
    await loadFeed();
  } catch (err) {
    console.error('boot error', err);
    window.location.href = '/login.html';
  }
})();

function paintMe(user) {
  const initial = $('#mf-avatar-initial');
  if (initial && user?.handle) initial.textContent = user.handle.charAt(0).toUpperCase();
  const menuInitial = $('#mf-app-menu-initial');
  if (menuInitial && user?.handle) menuInitial.textContent = user.handle.charAt(0).toUpperCase();
  const menuHandle = $('#mf-app-menu-handle');
  if (menuHandle && user?.handle) menuHandle.textContent = '@' + user.handle;
  const menuEmail = $('#mf-app-menu-email');
  if (menuEmail && user?.email) menuEmail.textContent = user.email;
  const publicLink = $('#mf-menu-public-profile');
  if (publicLink && user?.handle) publicLink.href = '/@' + user.handle;
}

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

// ============ Feed ============

let _feedPollTimer = null;

async function loadFeed() {
  const feed = $('#mf-feed');
  if (!feed) return;
  const res = await fetch(`${API}/api/feed`, { credentials: 'include' });
  if (res.status === 401) return showError('not_authenticated');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError(data.error);
  const pieces = data.pieces || [];
  renderFeed(pieces);

  // If any pieces are still processing on the pod, poll every 8s until all
  // are 'ready' or 'failed'. Welcome video swap takes ~3 min on RTX A6000.
  const hasProcessing = pieces.some((p) => p.status === 'processing');
  if (_feedPollTimer) clearTimeout(_feedPollTimer);
  if (hasProcessing) {
    _feedPollTimer = setTimeout(loadFeed, 8000);
  }
}

function renderFeed(pieces) {
  const feed = $('#mf-feed');
  if (pieces.length === 0) {
    feed.innerHTML = `
      <div class="mf-feed-empty">
        <h2>Your Mainfeed is empty</h2>
        <p>Your first piece is on its way.</p>
      </div>`;
    return;
  }
  feed.innerHTML = pieces.map(pieceCard).join('');
}

function pieceCard(p) {
  // Pieces still being generated on the pod show a placeholder card.
  if (p.status === 'processing') {
    const caption = String(p.caption || '').trim();
    return `
      <article class="mf-piece mf-piece--processing" data-id="${p.id}" data-status="processing">
        <div class="mf-piece-stage mf-piece-stage--processing">
          <div class="mf-piece-spinner" aria-hidden="true"></div>
          <div class="mf-piece-processing-msg">Your Mainfeed is being made…<br><span style="opacity:0.6;font-size:0.85em">about 3 minutes</span></div>
          ${caption ? `<div class="mf-piece-overlay mf-piece-overlay--top">${escapeHtml(caption)}</div>` : ''}
        </div>
      </article>
    `;
  }
  if (p.status === 'failed') {
    return `
      <article class="mf-piece mf-piece--failed" data-id="${p.id}" data-status="failed">
        <div class="mf-piece-stage mf-piece-stage--failed">
          <div class="mf-piece-processing-msg">This one didn't render. We'll try again on your next diary entry.</div>
        </div>
      </article>
    `;
  }
  const caption = String(p.caption || '').trim();
  const mediaTag = p.type === 'video'
    ? `<video class="mf-piece-media" src="${API}${p.file_url}" muted loop playsinline autoplay></video>`
    : `<img class="mf-piece-media" src="${API}${p.file_url}" alt="" crossorigin="use-credentials" />`;
  const pubText = p.public ? 'Unpublish' : 'Publish';
  const pubClass = p.public ? 'mf-piece-action mf-piece-action--active' : 'mf-piece-action';
  return `
    <article class="mf-piece" data-id="${p.id}" data-caption="${escapeHtml(caption)}" data-url="${API}${p.file_url}" data-public="${p.public ? '1' : '0'}">
      <div class="mf-piece-stage">
        ${mediaTag}
        ${caption ? `<div class="mf-piece-overlay mf-piece-overlay--top">${escapeHtml(caption)}</div>` : ''}
        <div class="mf-piece-watermark">Mainfeed.app · @${escapeHtml(currentUser?.handle || '')}</div>
      </div>
      <div class="mf-piece-actions">
        <button class="mf-piece-action" data-piece-action="download" data-id="${p.id}">Download</button>
        <button class="mf-piece-action" data-piece-action="share" data-id="${p.id}">Share</button>
        <button class="${pubClass}" data-piece-action="publish-toggle" data-id="${p.id}">${pubText}</button>
      </div>
    </article>
  `;
}

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

async function togglePublish(id, card, btn) {
  const isPublic = card.dataset.public === '1';
  setBusy(btn, isPublic ? 'Unpublishing…' : 'Publishing…');
  try {
    const res = await fetch(`${API}/api/piece/${id}/${isPublic ? 'unpublish' : 'publish'}`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
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

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
