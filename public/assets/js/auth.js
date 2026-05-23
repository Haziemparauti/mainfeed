// Mainfeed — signup / login (with branching onboarding questionnaire)

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.mainfeed.app';

const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);

const ERROR_MESSAGES = {
  invalid_handle: 'Handle: 2-20 lowercase letters and numbers only.',
  reserved_handle: 'That handle is reserved. Pick another.',
  invalid_email: 'Please enter a valid email.',
  weak_password: 'Password must be 8+ characters.',
  consent_required: 'Please tick both boxes.',
  need_5_selfies: 'Upload at least 5 selfies.',
  invalid_image_type: 'Selfies must be JPEG, PNG, WebP, or HEIC.',
  selfie_too_large: 'Each selfie must be under 8 MB.',
  handle_or_email_taken: 'That handle or email is already in use.',
  invalid_credentials: 'Wrong handle/email or password.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
  missing_fields: 'Please fill in all fields.',
  expected_multipart: 'Form submission error. Refresh and try again.',
  not_authenticated: 'Please log in first.',
  profile_required: 'Please answer the onboarding questions first.',
  invalid_profile: 'Onboarding data was malformed. Refresh and try again.',
  user_cap_reached: 'Mainfeed is in private testing right now — signups are temporarily closed. Check back soon.',
  network_error: 'Network hiccup. Check your connection and try again.',
};

function showError(code) {
  alert(ERROR_MESSAGES[code] || `Something went wrong (${code || 'unknown error'}).`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ============ Outer step navigation ============

const steps = $$('.mf-step');
const progress = $('.mf-progress');

function showStep(n) {
  steps.forEach((s) => { s.hidden = s.dataset.step !== String(n); });
  if (progress) progress.dataset.step = String(n);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============ Onboarding question tree ============

const ONBOARDING_TREE = [
  { id: 'gender', text: 'You are...', type: 'single', options: ['male', 'female', 'non-binary', 'prefer not to say'] },
  { id: 'age_range', text: 'How old?', type: 'single', options: ['18-24', '25-34', '35-44', '45+'] },
  {
    id: 'daily_life',
    text: 'What do you mostly do?',
    type: 'single',
    options: ['student', 'work', 'both', 'between things'],
    follow: {
      'student': { id: 'studying_what', text: 'What are you studying?', type: 'text', placeholder: 'comp sci, art, etc' },
      'work': { id: 'work_field', text: 'What field?', type: 'single', options: ['tech', 'creative', 'service', 'office', 'trade', 'other'] },
      'both': { id: 'drains_more', text: 'Which drains you more?', type: 'single', options: ['work', 'school', 'both equally'] },
      'between things': { id: 'whats_next', text: "What's next for you?", type: 'text', placeholder: 'one line' },
    },
  },
  { id: 'day_vibe', text: 'How are your days lately?', type: 'single', options: ['energizing', 'draining', 'mixed'] },
  { id: 'hobbies', text: 'Pick what you love (up to 3)', type: 'multi', max: 3, options: ['gaming', 'music', 'cooking', 'sports', 'reading', 'art', 'outdoors', 'travel'] },
  { id: 'personality', text: 'How would you describe yourself?', type: 'single', options: ['chill', 'chaotic', 'dramatic', 'shy', 'loud'] },
  {
    id: 'animals',
    text: 'Animals?',
    type: 'single',
    options: ['have a pet', 'want one', 'no thanks'],
    follow: {
      'have a pet': { id: 'pet_type', text: 'What kind?', type: 'text', placeholder: 'cat named Mochi, dog, etc' },
      'want one': { id: 'want_what', text: 'What kind would you get?', type: 'single', options: ['cat', 'dog', 'exotic', 'something else'] },
      'no thanks': { id: 'why_no_pets', text: 'Allergic, or just not your thing?', type: 'single', options: ['allergic', 'not my thing', 'too much work'] },
    },
  },
  {
    id: 'relationship',
    text: 'Relationship status?',
    type: 'single',
    options: ['single', 'dating', 'married', "it's complicated"],
    follow: {
      'single': { id: 'looking', text: 'Looking, or happy single?', type: 'single', options: ['looking', 'happy single', "don't know yet"] },
      'dating': { id: 'dating_how_long', text: 'How long?', type: 'single', options: ['less than 6 months', '6 months to 1 year', '1 to 3 years', '3+ years'] },
      'married': { id: 'married_how_long', text: 'How long?', type: 'single', options: ['less than 1 year', '1-5 years', '5-10 years', '10+ years'] },
      "it's complicated": { id: 'complicated_what', text: 'One sentence about it', type: 'text', placeholder: 'just a vibe' },
    },
  },
  { id: 'kids', text: 'Kids?', type: 'single', options: ['want them', 'have them', 'no thanks', 'not sure'] },
  { id: 'one_word', text: 'One word that describes you', type: 'text', placeholder: 'go' },
];

let onboardingQueue = null;
let onboardingIdx = 0;
let onboardingAnswers = {};

function startOnboarding() {
  onboardingQueue = ONBOARDING_TREE.slice();
  onboardingIdx = 0;
  onboardingAnswers = {};
  renderOnboardingQuestion();
}

function renderOnboardingQuestion() {
  const container = $('#mf-onboarding');
  if (!container) return;
  const q = onboardingQueue[onboardingIdx];
  if (!q) {
    // Done — proceed to consent
    showStep(5);
    return;
  }
  const qNum = onboardingIdx + 1;
  const qTotal = onboardingQueue.length;
  let bodyHtml = '';
  if (q.type === 'single') {
    bodyHtml = `<div class="mf-ob-options">` +
      q.options.map((opt) => `<button class="mf-ob-opt" type="button" data-ob-value="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`).join('') +
      `</div>`;
  } else if (q.type === 'multi') {
    bodyHtml = `
      <div class="mf-ob-multi">
        ${q.options.map((opt) => `<label class="mf-ob-chip"><input type="checkbox" value="${escapeHtml(opt)}" data-ob-multi /><span>${escapeHtml(opt)}</span></label>`).join('')}
      </div>
      <p class="mf-ob-hint">Pick up to ${q.max || 3}.</p>
      <button class="mf-cta mf-cta-block" type="button" data-ob-multi-continue>Continue</button>
    `;
  } else if (q.type === 'text') {
    bodyHtml = `
      <input type="text" class="mf-ob-text" placeholder="${escapeHtml(q.placeholder || '')}" maxlength="100" data-ob-text />
      <button class="mf-cta mf-cta-block" type="button" data-ob-text-continue>Continue</button>
    `;
  }
  container.innerHTML = `
    <div class="mf-ob-progress">${qNum} of ${qTotal}</div>
    <h2 class="mf-ob-q">${escapeHtml(q.text)}</h2>
    ${bodyHtml}
  `;
  // Focus text input if present
  setTimeout(() => $('[data-ob-text]')?.focus(), 80);
}

function answerOnboarding(value) {
  const q = onboardingQueue[onboardingIdx];
  if (!q) return;
  onboardingAnswers[q.id] = value;
  // Insert follow-up question right after current if applicable
  if (q.type === 'single' && q.follow && q.follow[value]) {
    onboardingQueue.splice(onboardingIdx + 1, 0, q.follow[value]);
  }
  onboardingIdx++;
  renderOnboardingQuestion();
}

document.addEventListener('click', (e) => {
  // Single-choice option
  const opt = e.target.closest('[data-ob-value]');
  if (opt) {
    answerOnboarding(opt.dataset.obValue);
    return;
  }
  // Multi-choice continue
  if (e.target.closest('[data-ob-multi-continue]')) {
    const q = onboardingQueue[onboardingIdx];
    const picks = [...$$('[data-ob-multi]')].filter((i) => i.checked).map((i) => i.value);
    if (picks.length === 0) { alert('Pick at least one.'); return; }
    if (q.max && picks.length > q.max) { alert(`Pick up to ${q.max}.`); return; }
    answerOnboarding(picks);
    return;
  }
  // Text continue
  if (e.target.closest('[data-ob-text-continue]')) {
    const input = $('[data-ob-text]');
    const val = (input?.value || '').trim();
    if (!val) { alert('Type something or skip later.'); return; }
    answerOnboarding(val);
    return;
  }
});

// Enforce multi-select cap (deselect oldest if over)
document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-ob-multi]')) return;
  const q = onboardingQueue ? onboardingQueue[onboardingIdx] : null;
  if (!q || q.type !== 'multi' || !q.max) return;
  const checked = [...$$('[data-ob-multi]')].filter((i) => i.checked);
  if (checked.length > q.max) {
    e.target.checked = false;
    alert(`Pick up to ${q.max}.`);
  }
});

// Enter key submits text inputs
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.matches('[data-ob-text]')) {
    e.preventDefault();
    $('[data-ob-text-continue]')?.click();
  }
});

// ============ Action router (signup/login flow) ============

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  const action = btn?.dataset.action;
  if (!action) return;

  if (action === 'next-1') {
    const handle = $('#mf-handle')?.value.trim().toLowerCase();
    const email = $('#mf-email')?.value.trim();
    const password = $('#mf-password')?.value;
    if (!handle || !/^[a-z0-9]{2,20}$/.test(handle)) return showError('invalid_handle');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('invalid_email');
    if (!password || password.length < 8) return showError('weak_password');
    showStep(2);
  } else if (action === 'next-2') {
    const inputs = $$('.mf-selfie-slot input[type="file"]');
    const filled = [...inputs].filter((i) => i.files?.[0]).length;
    if (filled < 5) return showError('need_5_selfies');
    showStep(3);
  } else if (action === 'start-liveness') {
    // Stub — DIY video liveness lands later. Just advance to onboarding.
    showStep(4);
    startOnboarding();
  } else if (action === 'finish') {
    if (!$('#mf-consent-age')?.checked || !$('#mf-consent-terms')?.checked) return showError('consent_required');
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
    fd.set('consent_terms', 'true');
    fd.set('profile', JSON.stringify(onboardingAnswers));

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
