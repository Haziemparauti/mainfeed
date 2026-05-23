// Mainfeed — landing page

// Menu drawer
const menuToggle = document.getElementById('mf-menu-toggle');
const menu = document.getElementById('mf-menu');
const menuClose = document.getElementById('mf-menu-close');

function openMenu() {
  if (!menu) return;
  menu.hidden = false;
}

function closeMenu() {
  if (!menu) return;
  menu.hidden = true;
}

menuToggle?.addEventListener('click', openMenu);
menuClose?.addEventListener('click', closeMenu);

// Close menu when tapping the dark area (outside the head + list)
menu?.addEventListener('click', (e) => {
  if (e.target === menu) closeMenu();
});

// Close menu on Escape (desktop)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu && !menu.hidden) closeMenu();
});

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
