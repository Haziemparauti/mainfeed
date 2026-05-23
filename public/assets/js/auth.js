// Mainfeed — signup / login (wired to real API)

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.mainfeed.app';

const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);

const ERROR_MESSAGES = {
  invalid_handle: 'Handle must be 2-20 lowercase letters/numbers.',
  reserved_handle: 'That handle is reserved. Pick another.',
  invalid_email: 'Please enter a valid email address.',
  weak_password: 'Password must be 8+ characters.',
  consent_required: 'Please check all three consent boxes.',
  need_5_selfies: 'Upload at least 5 selfies.',
  invalid_image_type: 'Selfies must be JPEG, PNG, WebP, or HEIC.',
  selfie_too_large: 'Each selfie must be under 8 MB.',
  handle_or_email_taken: 'That handle or email is already in use.',
  invalid_credentials: 'Wrong handle/email or password.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  missing_fields: 'Please fill in all fields.',
  expected_multipart: 'Form submission error. Refresh and try again.',
  not_authenticated: 'Please log in first.',
  empty_entry: 'Tell us something first.',
  too_long: 'Keep it under 500 characters.',
};

function showError(code) {
  alert(ERROR_MESSAGES[code] || `Something went wrong (${code || 'unknown error'}).`);
}

// ============ Multi-step UX ============

const steps = $$('.mf-step');
const progress = $('.mf-progress');

function showStep(n) {
  steps.forEach((s) => {
    s.hidden = s.dataset.step !== String(n);
  });
  if (progress) progress.dataset.step = String(n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============ Action router ============

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  const action = btn?.dataset.action;
  if (!action) return;

  if (action === 'next-1') {
    const handle = $('#mf-handle')?.value.trim().toLowerCase();
    const email = $('#mf-email')?.value.trim();
    const password = $('#mf-password')?.value;

    if (!handle || !/^[a-z0-9]{2,20}$/.test(handle)) {
      return showError('invalid_handle');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return showError('invalid_email');
    }
    if (!password || password.length < 8) {
      return showError('weak_password');
    }
    showStep(2);
  } else if (action === 'next-2') {
    const inputs = $$('.mf-selfie-slot input[type="file"]');
    const filled = [...inputs].filter((i) => i.files?.[0]).length;
    if (filled < 5) return showError('need_5_selfies');
    showStep(3);
  } else if (action === 'start-liveness') {
    // Persona integration lands later; skip for v0
    showStep(4);
  } else if (action === 'finish') {
    if (!$('#mf-consent-age')?.checked || !$('#mf-consent-ai')?.checked || !$('#mf-consent-terms')?.checked) {
      return showError('consent_required');
    }
    await doSignup(btn);
  } else if (action === 'login') {
    await doLogin(btn);
  }
});

// ============ Signup ============

async function doSignup(btn) {
  setBusy(btn, true);
  try {
    const fd = new FormData();
    fd.set('handle', $('#mf-handle').value.trim().toLowerCase());
    fd.set('email', $('#mf-email').value.trim());
    fd.set('password', $('#mf-password').value);
    fd.set('consent_age', 'true');
    fd.set('consent_ai', 'true');
    fd.set('consent_terms', 'true');

    const inputs = $$('.mf-selfie-slot input[type="file"]');
    let idx = 0;
    for (const inp of inputs) {
      const file = inp.files?.[0];
      if (file) fd.set(`selfie_${idx++}`, file);
    }

    const res = await fetch(`${API}/api/signup`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error);
    window.location.href = '/app.html';
  } catch (err) {
    showError('network_error');
  } finally {
    setBusy(btn, false);
  }
}

// ============ Login ============

async function doLogin(btn) {
  setBusy(btn, true);
  try {
    const id = $('#mf-login-id').value.trim().toLowerCase();
    const password = $('#mf-login-password').value;
    if (!id || !password) return showError('missing_fields');

    const res = await fetch(`${API}/api/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error);
    window.location.href = '/app.html';
  } catch (err) {
    showError('network_error');
  } finally {
    setBusy(btn, false);
  }
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.style.opacity = busy ? '0.6' : '1';
  if (busy) btn.dataset.label = btn.textContent;
  btn.textContent = busy ? 'Working…' : (btn.dataset.label || btn.textContent);
}

// ============ Selfie preview ============

document.addEventListener('change', (e) => {
  if (!e.target.matches('.mf-selfie-slot input')) return;
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const slot = e.target.closest('.mf-selfie-slot');
    slot.style.backgroundImage = `url(${ev.target.result})`;
    slot.classList.add('mf-selfie-slot--filled');
  };
  reader.readAsDataURL(file);
});

// ============ Service worker ============

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
