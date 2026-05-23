// Mainfeed — main app (feed + diary + download/share with caption baked on)

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.mainfeed.app';

const $ = (q) => document.querySelector(q);

const ERROR_MESSAGES = {
  not_authenticated: 'Session expired. Logging out…',
  empty_entry: 'Tell us something first.',
  too_long: 'Keep it under 500 characters.',
  rate_limited: 'Slow down — too many entries. Try in a bit.',
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
  if (initial && user?.handle) {
    initial.textContent = user.handle.charAt(0).toUpperCase();
  }
}

// ============ Feed ============

async function loadFeed() {
  const feed = $('#mf-feed');
  if (!feed) return;
  const res = await fetch(`${API}/api/feed`, { credentials: 'include' });
  if (res.status === 401) return showError('not_authenticated');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showError(data.error);
  renderFeed(data.pieces || []);
}

function renderFeed(pieces) {
  const feed = $('#mf-feed');
  if (pieces.length === 0) {
    feed.innerHTML = `
      <div class="mf-feed-empty">
        <h2>Your Mainfeed is empty</h2>
        <p>Tell us about your day above and AI will make content about you.</p>
      </div>`;
    return;
  }
  feed.innerHTML = pieces.map(pieceCard).join('');
}

// Split a caption on ' / ' into [top, bottom]. If no delimiter, all goes to bottom.
function splitCaption(caption) {
  const c = String(caption || '');
  const idx = c.indexOf(' / ');
  if (idx >= 0) {
    return { top: c.slice(0, idx).trim(), bottom: c.slice(idx + 3).trim() };
  }
  return { top: '', bottom: c.trim() };
}

function pieceCard(p) {
  const { top, bottom } = splitCaption(p.caption);
  const mediaTag = p.type === 'video'
    ? `<video class="mf-piece-media" src="${API}${p.file_url}" muted loop playsinline></video>`
    : `<img class="mf-piece-media" src="${API}${p.file_url}" alt="" crossorigin="use-credentials" />`;
  return `
    <article class="mf-piece" data-id="${p.id}" data-caption="${escapeHtml(p.caption || '')}" data-url="${API}${p.file_url}">
      <div class="mf-piece-stage">
        ${mediaTag}
        ${top ? `<div class="mf-piece-overlay mf-piece-overlay--top">${escapeHtml(top)}</div>` : ''}
        ${bottom ? `<div class="mf-piece-overlay mf-piece-overlay--bottom">${escapeHtml(bottom)}</div>` : ''}
        <div class="mf-piece-watermark">Mainfeed.app · @${escapeHtml(currentUser?.handle || '')}</div>
      </div>
      <div class="mf-piece-actions">
        <button class="mf-piece-action" data-piece-action="download" data-id="${p.id}">Download</button>
        <button class="mf-piece-action" data-piece-action="share" data-id="${p.id}">Share</button>
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
});

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
  const caption = card.dataset.caption || '';
  const { top, bottom } = splitCaption(caption);
  const blob = await loadImageBlob(url);
  const imgBitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = imgBitmap.width;
  canvas.height = imgBitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgBitmap, 0, 0);

  drawMemeCaption(ctx, canvas.width, canvas.height, top, bottom);
  drawWatermark(ctx, canvas.width, canvas.height, `Mainfeed.app · @${currentUser?.handle || ''}`);

  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
  );
}

function drawMemeCaption(ctx, w, h, top, bottom) {
  const fontSize = Math.round(h * 0.06);
  const padding = Math.round(w * 0.05);
  const maxWidth = w - padding * 2;
  ctx.font = `bold ${fontSize}px Impact, "Anton", "Arial Black", sans-serif`;
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = Math.max(2, fontSize * 0.08);
  ctx.lineJoin = 'round';
  ctx.textAlign = 'center';

  if (top) {
    ctx.textBaseline = 'top';
    drawWrappedText(ctx, top.toUpperCase(), w / 2, padding, maxWidth, fontSize * 1.1);
  }
  if (bottom) {
    ctx.textBaseline = 'bottom';
    drawWrappedTextFromBottom(ctx, bottom.toUpperCase(), w / 2, h - padding, maxWidth, fontSize * 1.1);
  }
}

function drawWrappedText(ctx, text, x, startY, maxWidth, lineHeight) {
  const lines = wrapLines(ctx, text, maxWidth);
  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
}

function drawWrappedTextFromBottom(ctx, text, x, endY, maxWidth, lineHeight) {
  const lines = wrapLines(ctx, text, maxWidth);
  lines.forEach((line, i) => {
    const y = endY - (lines.length - 1 - i) * lineHeight;
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

// ============ Diary ============

const diaryInput = $('#mf-diary-input');
const diaryLen = $('#mf-diary-len');
if (diaryInput && diaryLen) {
  diaryInput.addEventListener('input', () => {
    diaryLen.textContent = String(diaryInput.value.length);
  });
}

$('#mf-diary-submit')?.addEventListener('click', async () => {
  const content = diaryInput.value.trim();
  if (!content) return showError('empty_entry');
  const btn = $('#mf-diary-submit');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Making content…';
  try {
    const res = await fetch(`${API}/api/diary/create`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error);
    diaryInput.value = '';
    diaryLen.textContent = '0';
    if (data.pieces_generated === 0) {
      alert('Hmm, generation hiccupped. Try again in a sec.');
    }
    await loadFeed();
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// ============ Logout (call from console for now, menu wiring later) ============

window.mfLogout = async function () {
  await fetch(`${API}/api/logout`, { method: 'POST', credentials: 'include' });
  window.location.href = '/';
};

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
