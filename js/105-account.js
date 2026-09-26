'use strict';

/* ---------------- profile + account menu (v37) ---------------- */

// Default avatar choices — dark romance / romantasy / BookTok themed.
const DEFAULT_AVATARS = [
  { id: 'rose', label: 'Dark Rose', src: 'img/avatars/avatar-rose.webp' },
  { id: 'moon', label: 'Moon & Dagger', src: 'img/avatars/avatar-moon.webp' },
  { id: 'dragon', label: 'Dragon', src: 'img/avatars/avatar-dragon.webp' },
  { id: 'raven', label: 'Raven', src: 'img/avatars/avatar-raven.webp' },
  { id: 'book', label: 'Spellbook', src: 'img/avatars/avatar-book.webp' },
  { id: 'crown', label: 'Thorn Crown', src: 'img/avatars/avatar-crown.webp' },
];

// Profile storage: one slot per user id ('offline' when not signed in).
function profileKey() {
  return 'spicyshelves.profile.' + (cloudUser ? cloudUser.id : 'offline');
}
function blankProfile() {
  return { firstName: '', lastName: '', avatar: { type: 'letter' } };
}
function loadProfile() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(profileKey()) || 'null'); } catch (e) {}
  const base = blankProfile();
  if (!p || typeof p !== 'object') return base;
  base.firstName = String(p.firstName || '');
  base.lastName = String(p.lastName || '');
  if (p.avatar && typeof p.avatar === 'object') {
    if (p.avatar.type === 'default' && DEFAULT_AVATARS.some(a => a.id === p.avatar.id)) base.avatar = { type: 'default', id: p.avatar.id };
    else if (p.avatar.type === 'upload' && p.avatar.dataUrl) base.avatar = { type: 'upload', dataUrl: p.avatar.dataUrl };
  }
  return base;
}
function saveProfile(p) {
  try { localStorage.setItem(profileKey(), JSON.stringify(p)); } catch (e) {}
}
// Adopt names + default avatar from Supabase user_metadata on sign-in so the
// profile roams across devices. Only into a fresh (never edited) local slot —
// any local edit means "set up here" and always wins.
function adoptCloudProfile(user) {
  const md = (user && user.user_metadata) || {};
  if (!md.first_name && !md.last_name && !md.avatar_id) return;
  const p = loadProfile();
  if (p.firstName || p.lastName || p.avatar.type !== 'letter') return;
  let changed = false;
  if (md.first_name) { p.firstName = String(md.first_name); changed = true; }
  if (md.last_name) { p.lastName = String(md.last_name); changed = true; }
  if (md.avatar_id && DEFAULT_AVATARS.some(a => a.id === md.avatar_id)) {
    p.avatar = { type: 'default', id: md.avatar_id }; changed = true;
  }
  if (changed) saveProfile(p);
}
// Mirror names + default avatar choice to the cloud account (best-effort).
// Uploaded photos stay on this device — the cloud keeps the last themed choice
// as the roaming fallback instead.
async function pushCloudProfile(p) {
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return;
    const data = { first_name: p.firstName || '', last_name: p.lastName || '' };
    if (p.avatar.type === 'default') data.avatar_id = p.avatar.id;
    else if (p.avatar.type === 'letter') data.avatar_id = '';
    await sb.auth.updateUser({ data: data });
  } catch (e) { /* offline — local copy is the source of truth */ }
}

function avatarSrc(p) {
  if (!p) return null;
  if (p.avatar.type === 'upload' && p.avatar.dataUrl) return p.avatar.dataUrl;
  if (p.avatar.type === 'default') {
    const a = DEFAULT_AVATARS.find(x => x.id === p.avatar.id);
    if (a) return a.src;
  }
  return null;
}
function avatarLetter(p) {
  const n = (p.firstName || '').trim();
  if (n) return n[0].toUpperCase();
  const e = (cloudUser && cloudUser.email) || '';
  return (e.trim()[0] || '•').toUpperCase();
}
function avatarHTML(p, cls) {
  const src = avatarSrc(p);
  if (src) return '<img class="' + cls + '" src="' + esc(src) + '" alt="Profile picture">';
  return '<span class="' + cls + ' letter">' + esc(avatarLetter(p)) + '</span>';
}
const signedIn = () => !!(cloudUser && cloudUser.email);

/* ---- topbar + dropdown menu ---- */
function renderTopbar() {
  const btn = document.getElementById('menu-btn');
  if (!btn) return;
  const p = loadProfile();
  btn.innerHTML = signedIn()
    ? avatarHTML(p, 'menu-avatar-img')
    : '<span class="menu-avatar-img letter dim">👤</span>';
  btn.title = signedIn() ? 'Account — ' + cloudUser.email : 'Menu';
  closeMenu();
}
function menuItems() {
  if (signedIn()) return [
    { id: 'profile', icon: '👤', label: 'Profile' },
    { id: 'settings', icon: '⚙️', label: 'Settings' },
    { id: 'logout', icon: '🚪', label: 'Logout' },
  ];
  const items = [{ id: 'settings', icon: '⚙️', label: 'Settings' }];
  // The gate itself is the sign-in screen — no need for a redundant item there.
  if (cloudConfigured() && !document.getElementById('gate-signin')) {
    items.push({ id: 'signin', icon: '🔑', label: 'Sign in' });
  }
  return items;
}
function openMenu() {
  const pop = document.getElementById('menu-pop');
  if (!pop) return;
  pop.innerHTML =
    (signedIn() ? '<div class="menu-email">' + esc(cloudUser.email) + '</div>' : '') +
    menuItems().map(m =>
      '<button data-m="' + m.id + '"><span class="mi">' + m.icon + '</span>' + m.label + '</button>').join('');
  pop.hidden = false;
  pop.querySelectorAll('[data-m]').forEach(b =>
    b.addEventListener('click', () => menuAction(b.dataset.m)));
}
function closeMenu() {
  const pop = document.getElementById('menu-pop');
  if (pop) { pop.hidden = true; pop.innerHTML = ''; }
}
function menuAction(id) {
  closeMenu();
  if (id === 'profile') go('profile');
  else if (id === 'settings') go('settings');
  else if (id === 'signin') {
    try { localStorage.removeItem(OFFLINE_KEY); } catch (e) {}
    renderGate();
  }
  else if (id === 'logout') {
    if (confirm('Sign out of ' + cloudUser.email + '?\nYour books stay on this device.')) cloudSignOut();
  }
}
const _menuBtn = document.getElementById('menu-btn');
if (_menuBtn) _menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = document.getElementById('menu-pop');
  if (pop && !pop.hidden) closeMenu(); else openMenu();
});
document.addEventListener('click', (e) => {
  const pop = document.getElementById('menu-pop');
  if (pop && !pop.hidden && !e.target.closest('.topbar-menu-wrap')) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

/* ---- profile view ---- */
function fileToAvatarDataURL(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const S = 256, scale = Math.min(1, S / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read that image')); };
    img.src = url;
  });
}
function renderProfile() {
  const p = loadProfile();
  const email = (cloudUser && cloudUser.email) || '';
  const pickSel = (id) => (p.avatar.type === 'default' && p.avatar.id === id) ? ' sel' : '';
  setView(
    '<div class="view-head"><button class="btn ghost sm" id="pf-back">← Back</button>' +
    '<h2 class="serif">Profile</h2></div>' +
    '<div class="pf-card">' +
      '<div class="pf-avatar-row">' + avatarHTML(p, 'pf-avatar') +
      '<div><button class="btn ghost sm" id="pf-change">Change picture</button>' +
      '<p class="note" style="margin:6px 0 0">Pick a themed avatar or upload your own.</p></div></div>' +
      '<div id="pf-picker" class="pf-picker" hidden>' +
        '<div class="pf-grid">' +
        DEFAULT_AVATARS.map(a =>
          '<button class="pf-pick' + pickSel(a.id) + '" data-av="' + a.id + '" title="' + esc(a.label) + '" aria-label="' + esc(a.label) + '">' +
          '<img src="' + a.src + '" alt="' + esc(a.label) + '"></button>').join('') +
        '<button class="pf-pick' + (p.avatar.type === 'upload' ? ' sel' : '') + '" data-av="__upload" title="Upload your own" aria-label="Upload your own">' +
          '<span class="pf-upload">📷</span></button>' +
        '<button class="pf-pick' + (p.avatar.type === 'letter' ? ' sel' : '') + '" data-av="__letter" title="Just my initial" aria-label="Just my initial">' +
          '<span class="pf-letter">' + esc(avatarLetter(p)) + '</span></button>' +
        '</div>' +
        '<input type="file" id="pf-file" accept="image/*" hidden>' +
      '</div>' +
      '<div class="field"><label>First name</label>' +
      '<input id="pf-first" class="text-input" value="' + esc(p.firstName) + '" autocomplete="given-name" maxlength="40"></div>' +
      '<div class="field"><label>Last name</label>' +
      '<input id="pf-last" class="text-input" value="' + esc(p.lastName) + '" autocomplete="family-name" maxlength="40"></div>' +
      '<div class="field"><label>Email</label>' +
      '<input class="text-input" value="' + esc(email) + '" disabled></div>' +
      '<button class="btn block" id="pf-save">Save profile</button>' +
      '<p class="note">Your name and themed avatar sync to your cloud account when you\'re signed in.</p>' +
    '</div>'
  );
  document.getElementById('pf-back').addEventListener('click', () => go('library'));
  const picker = document.getElementById('pf-picker');
  document.getElementById('pf-change').addEventListener('click', () => {
    picker.hidden = !picker.hidden;
  });
  const applyAvatar = (av, msg) => {
    const np = loadProfile();
    np.avatar = av;
    saveProfile(np);
    pushCloudProfile(np);
    renderTopbar();
    renderProfile();
    if (msg) toast(msg);
  };
  picker.querySelectorAll('[data-av]').forEach(b =>
    b.addEventListener('click', () => {
      const id = b.dataset.av;
      if (id === '__letter') applyAvatar({ type: 'letter' }, 'Avatar cleared ✨');
      else if (id === '__upload') document.getElementById('pf-file').click();
      else applyAvatar({ type: 'default', id: id }, 'Avatar updated ✨');
    }));
  document.getElementById('pf-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const dataUrl = await fileToAvatarDataURL(f);
      applyAvatar({ type: 'upload', dataUrl: dataUrl }, 'Photo uploaded ✨');
    } catch (err) { toast('Could not use that photo — try a JPG or PNG.'); }
  });
  document.getElementById('pf-save').addEventListener('click', () => {
    const np = loadProfile();
    np.firstName = document.getElementById('pf-first').value.trim().slice(0, 40);
    np.lastName = document.getElementById('pf-last').value.trim().slice(0, 40);
    saveProfile(np);
    pushCloudProfile(np);
    renderTopbar();
    toast('Profile saved ✨');
  });
}

renderTopbar();
