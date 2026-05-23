// Mainfeed — main app (v0 skeleton)
// Backend + generation lands week 3.

const API = window.location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://api.mainfeed.app';

const $ = (q) => document.querySelector(q);

// Diary character counter
const diaryInput = $('#mf-diary-input');
const diaryLen = $('#mf-diary-len');
if (diaryInput && diaryLen) {
  diaryInput.addEventListener('input', () => {
    diaryLen.textContent = String(diaryInput.value.length);
  });
}

// Diary submit
$('#mf-diary-submit')?.addEventListener('click', async () => {
  const content = diaryInput.value.trim();
  if (!content) {
    alert('Tell us something about your day first.');
    return;
  }
  // Generation pipeline lands week 3
  alert('Generation pipeline coming week 3.\n\nYour entry: "' + content + '"');
});

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
