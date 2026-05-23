// Mainfeed — main app (feed + diary + download)

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

// ============ Boot ============

(async function boot() {
  try {
    const meRes = await fetch(`${API}/api/me`, { credentials: 'include' });
    if (!meRes.ok) {
      window.location.href = '/login.html';
      return;
    }
    const me = await meRes.json();
    paintMe(me.user);
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

function pieceCard(p) {
  const media = p.type === 'video'
    ? `<video class="mf-piece-media" src="${API}${p.file_url}" muted loop playsinline></video>`
    : `<img class="mf-piece-media" src="${API}${p.file_url}" alt="" />`;
  return `
    <article class="mf-piece" data-id="${p.id}">
      ${media}
      <div class="mf-piece-body">
        <p class="mf-piece-caption">${escapeHtml(p.caption || '')}</p>
        <div class="mf-piece-actions">
          <button class="mf-piece-action" data-piece-action="download" data-id="${p.id}">Download</button>
          <button class="mf-piece-action" data-piece-action="share" data-id="${p.id}">Share</button>
          <button class="mf-piece-action" data-piece-action="delete" data-id="${p.id}">Delete</button>
        </div>
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
  if (action === 'download') return downloadPiece(id);
  if (action === 'share') return sharePiece(id);
  if (action === 'delete') return deletePiece(id, btn);
});

function downloadPiece(id) {
  // Triggers an authenticated download (cookie is sent automatically on same eTLD+1)
  const a = document.createElement('a');
  a.href = `${API}/api/piece/${id}/file?download=1`;
  a.download = `mainfeed-${id}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function sharePiece(id) {
  const url = `${API}/api/piece/${id}/file`;
  if (navigator.share) {
    try {
      // Best path: fetch the file and share as a File so it goes into IG/TikTok/WhatsApp natively
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('fetch failed');
      const blob = await res.blob();
      const file = new File([blob], `mainfeed-${id}.jpg`, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: 'Made on Mainfeed.app' });
        return;
      }
      // Fallback: share the URL only (less useful since the URL is private)
      await navigator.share({ title: 'Mainfeed', text: 'Made on Mainfeed.app', url });
    } catch (err) {
      if (err && err.name !== 'AbortError') alert('Share failed. Use Download instead.');
    }
  } else {
    alert('Share not supported on this browser. Use Download instead.');
  }
}

async function deletePiece(id, btn) {
  if (!confirm('Delete this piece? This cannot be undone.')) return;
  btn.disabled = true;
  const res = await fetch(`${API}/api/piece/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    btn.disabled = false;
    const data = await res.json().catch(() => ({}));
    return showError(data.error);
  }
  const card = btn.closest('.mf-piece');
  card?.remove();
  // If feed is now empty, re-render empty state
  if (!$('.mf-piece')) renderFeed([]);
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
  btn.textContent = 'Working…';
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
    alert(data.message || 'Diary saved.');
    await loadFeed();
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// ============ Logout (via menu link wiring later) ============

window.mfLogout = async function () {
  await fetch(`${API}/api/logout`, { method: 'POST', credentials: 'include' });
  window.location.href = '/';
};

// ============ Service worker ============

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
