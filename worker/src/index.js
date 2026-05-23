// Mainfeed API worker (v0 skeleton)
// Full routes land week 2-3.

const ALLOWED_ORIGINS = new Set([
  'https://mainfeed.app',
  'https://www.mainfeed.app',
  'https://mainfeed.pages.dev',
  'http://localhost:8788',
  'http://localhost:8787',
]);

function cors(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://mainfeed.app';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, init = {}, origin = '') {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...cors(origin),
      ...(init.headers || {}),
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(origin) });
    }

    const path = url.pathname;

    // Health
    if (path === '/' || path === '/api/health') {
      return json({ ok: true, name: 'mainfeed-api', env: env.ENVIRONMENT || 'unknown' }, {}, origin);
    }

    // TODO weeks 2-3:
    //   POST /api/signup          — handle, email, password, selfies, liveness
    //   POST /api/login           — handle/email + password
    //   POST /api/diary/create    — diary entry + queue generation
    //   GET  /api/feed            — paginated feed
    //   GET  /api/piece/:id       — single piece
    //   DELETE /api/piece/:id     — soft delete
    //   POST /api/piece/:id/share — increment share counter
    //   POST /api/report          — report content
    //   POST /api/account/delete  — delete entire account

    return json({ error: 'not_found', path }, { status: 404 }, origin);
  },
};
