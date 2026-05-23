// Mainfeed — public profile page (no auth required)

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.mainfeed.app';

const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function splitCaption(caption) {
  const c = String(caption || '');
  const idx = c.indexOf(' / ');
  if (idx >= 0) return { top: c.slice(0, idx).trim(), bottom: c.slice(idx + 3).trim() };
  return { top: '', bottom: c.trim() };
}

(async function boot() {
  const params = new URLSearchParams(window.location.search);
  const handle = (params.get('handle') || '').toLowerCase().replace(/^@/, '');
  if (!handle) {
    renderNotFound('no handle');
    return;
  }
  // Rewrite the address bar to /@handle (cleaner than profile.html?handle=)
  if (window.location.pathname === '/profile.html') {
    history.replaceState({}, '', `/@${handle}`);
  }
  document.title = `@${handle} — Mainfeed`;
  try {
    const res = await fetch(`${API}/api/profile/${encodeURIComponent(handle)}`);
    if (res.status === 404) {
      renderNotFound(handle);
      return;
    }
    if (!res.ok) {
      renderError();
      return;
    }
    const data = await res.json();
    renderProfile(data.user, data.pieces || []);
  } catch (err) {
    console.error('profile load failed', err);
    renderError();
  }
})();

function renderProfile(user, pieces) {
  const hero = $('#mf-profile-hero');
  const initial = (user.handle || '?').charAt(0).toUpperCase();
  hero.innerHTML = `
    <div class="mf-profile-avatar"><span>${escapeHtml(initial)}</span></div>
    <h1 class="mf-profile-handle">@${escapeHtml(user.handle)}</h1>
    <p class="mf-profile-tag">${pieces.length === 0 ? 'this Mainfeed is private — they haven\'t published anything yet' : `${pieces.length} public piece${pieces.length === 1 ? '' : 's'}`}</p>
  `;

  const feed = $('#mf-public-feed');
  if (pieces.length === 0) {
    feed.innerHTML = `
      <div class="mf-profile-empty">
        <p>Their feed lives behind closed doors. But you can make your own.</p>
      </div>`;
    return;
  }
  feed.innerHTML = pieces.map((p) => publicPieceCard(p, user.handle)).join('');
}

function publicPieceCard(p, handle) {
  const { top, bottom } = splitCaption(p.caption);
  const mediaTag = p.type === 'video'
    ? `<video class="mf-piece-media" src="${API}${p.file_url}" muted loop playsinline autoplay></video>`
    : `<img class="mf-piece-media" src="${API}${p.file_url}" alt="" />`;
  return `
    <article class="mf-piece">
      <div class="mf-piece-stage">
        ${mediaTag}
        ${top ? `<div class="mf-piece-overlay mf-piece-overlay--top">${escapeHtml(top)}</div>` : ''}
        ${bottom ? `<div class="mf-piece-overlay mf-piece-overlay--bottom">${escapeHtml(bottom)}</div>` : ''}
        <div class="mf-piece-watermark">Mainfeed.app · @${escapeHtml(handle)}</div>
      </div>
    </article>
  `;
}

function renderNotFound(handle) {
  $('#mf-profile-hero').innerHTML = `
    <div class="mf-profile-avatar"><span>?</span></div>
    <h1 class="mf-profile-handle">@${escapeHtml(handle || 'unknown')}</h1>
    <p class="mf-profile-tag">no Mainfeed here (yet)</p>
  `;
  $('#mf-public-feed').innerHTML = `
    <div class="mf-profile-empty">
      <p>This handle isn't taken. Want it?</p>
    </div>`;
}

function renderError() {
  $('#mf-profile-hero').innerHTML = `
    <div class="mf-profile-avatar"><span>!</span></div>
    <h1 class="mf-profile-handle">something broke</h1>
    <p class="mf-profile-tag">try again in a sec</p>
  `;
}

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
