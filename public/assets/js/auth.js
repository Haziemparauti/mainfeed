// Mainfeed — signup / login client (v0 skeleton)
// Backend wiring lands week 2.

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.mainfeed.app';

const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);

// Multi-step signup
const steps = $$('.mf-step');
const progress = $('.mf-progress');

function showStep(n) {
  steps.forEach((s) => {
    s.hidden = s.dataset.step !== String(n);
  });
  if (progress) progress.dataset.step = String(n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Action router
document.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  if (action === 'next-1') {
    const handle = $('#mf-handle')?.value.trim().toLowerCase();
    const email = $('#mf-email')?.value.trim();
    const password = $('#mf-password')?.value;

    if (!handle || !/^[a-z0-9]{2,20}$/.test(handle)) {
      alert('Handle: 2-20 lowercase letters and numbers only.');
      return;
    }
    if (!email || !email.includes('@')) {
      alert('Please enter a valid email.');
      return;
    }
    if (!password || password.length < 8) {
      alert('Password must be 8+ characters.');
      return;
    }
    showStep(2);
  } else if (action === 'next-2') {
    const slots = $$('.mf-selfie-slot input');
    const filled = [...slots].filter((s) => s.files?.length).length;
    if (filled < 5) {
      alert('Upload all 5 selfies.');
      return;
    }
    showStep(3);
  } else if (action === 'start-liveness') {
    // Persona integration lands week 2
    alert('Face check integration coming week 2. Skipping for now.');
    showStep(4);
  } else if (action === 'finish') {
    if (!$('#mf-consent-age')?.checked || !$('#mf-consent-ai')?.checked || !$('#mf-consent-terms')?.checked) {
      alert('Please check all three boxes.');
      return;
    }
    // Backend wiring lands week 2
    alert('Backend not yet wired. Coming week 2 — your Mainfeed will appear in seconds when it is.');
  } else if (action === 'login') {
    alert('Login backend not yet wired. Coming week 2.');
  }
});

// Selfie preview
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

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
