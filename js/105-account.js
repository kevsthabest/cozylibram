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
  return { firstName: '', lastName: '', gender: '', avatar: { type: 'letter' }, avatarCloudPath: '', updatedAt: 0 };
}
function loadProfile() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(profileKey()) || 'null'); } catch (e) {}
  const base = blankProfile();
  if (!p || typeof p !== 'object') return base;
  base.firstName = String(p.firstName || '');
  base.lastName = String(p.lastName || '');
  base.gender = ['f', 'm', 'other'].indexOf(p.gender) !== -1 ? p.gender : ''; // v177: greeting term
  base.avatarCloudPath = String(p.avatarCloudPath || '');
  base.updatedAt = Number(p.updatedAt) || 0;
  if (p.avatar && typeof p.avatar === 'object') {
    if (p.avatar.type === 'default' && DEFAULT_AVATARS.some(a => a.id === p.avatar.id)) base.avatar = { type: 'default', id: p.avatar.id };
    else if (p.avatar.type === 'upload' && p.avatar.dataUrl) base.avatar = { type: 'upload', dataUrl: p.avatar.dataUrl };
  }
  return base;
}
function saveProfile(p) {
  try { localStorage.setItem(profileKey(), JSON.stringify(p)); } catch (e) {}
}
// Stamp a user edit and save it. The stamp is what last-write-wins sync
// compares across devices.
function touchProfile(p) {
  p.updatedAt = Date.now();
  saveProfile(p);
  return p;
}
// dataURL <-> Blob helpers for the avatar bucket (btoa/atob/arrayBuffer exist
// in both browsers and Node, so the test suite can exercise the real path).
function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl).split(',');
  const type = (parts[0].match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(parts[1] || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type });
}
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return 'data:' + (blob.type || 'image/jpeg') + ';base64,' + btoa(bin);
}
// One-time bridge: v37 briefly mirrored names into auth user_metadata.
// If this device never set a profile, carry those values forward once.
function adoptLegacyMetadata(user) {
  const md = (user && user.user_metadata) || {};
  if (!md.first_name && !md.last_name && !md.avatar_id) return;
  try {
    const flag = 'spicyshelves.profileMigrated.' + user.id;
    if (localStorage.getItem(flag)) return;
    localStorage.setItem(flag, '1');
  } catch (e) { return; }
  const p = loadProfile();
  if (p.firstName || p.lastName || p.avatar.type !== 'letter') return;
  if (md.first_name) p.firstName = String(md.first_name);
  if (md.last_name) p.lastName = String(md.last_name);
  if (md.avatar_id && DEFAULT_AVATARS.some(a => a.id === md.avatar_id)) p.avatar = { type: 'default', id: md.avatar_id };
  touchProfile(p);
}
// v178: the gender column may not exist yet on databases whose owner
// hasn't re-run supabase/schema.sql — detect that and retry without it so
// names/avatars keep syncing instead of failing silently.
function isMissingColumn(err) {
  if (!err) return false;
  if (/42703/i.test(String(err.code || ''))) return true;
  return /column .* does not exist/i.test(String(err.message || ''));
}
// Push this device's profile to the profiles table (best-effort). A newly
// picked photo is uploaded to the private `avatars` bucket first (one file
// per user, overwritten in place); the row just stores its path.
async function pushCloudProfile(p) {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return;
  try {
    let cloudPath = p.avatarCloudPath || '';
    if (p.avatar.type === 'upload' && p.avatar.dataUrl && sb.storage) {
      if (!cloudPath) {
        cloudPath = cloudUser.id + '/avatar.jpg';
        try {
          const up = await sb.storage.from('avatars').upload(cloudPath, dataUrlToBlob(p.avatar.dataUrl), { upsert: true, contentType: 'image/jpeg' });
          if (up.error) throw up.error;
        } catch (ue) {
          // v95: surface setup problems (missing bucket / storage policies)
          // instead of swallowing them — network blips stay quiet and retry.
          const m = String((ue && ue.message) || ue || '');
          if (/bucket|not found|policy|permission|denied|row-level|rls/i.test(m)) {
            toast('Profile photo backup failed: ' + m);
          }
          throw ue;
        }
        p.avatarCloudPath = cloudPath;
        saveProfile(p);
      }
    } else if (p.avatar.type !== 'upload' && cloudPath) {
      cloudPath = '';
      p.avatarCloudPath = '';
      saveProfile(p);
    }
    const baseRow = () => ({
      user_id: cloudUser.id,
      first_name: p.firstName || '',
      last_name: p.lastName || '',
      avatar_id: p.avatar.type === 'default' ? p.avatar.id : '',
      avatar_path: cloudPath,
      updated_at: new Date(p.updatedAt || Date.now()).toISOString()
    });
    let up = await sb.from('profiles').upsert(
      Object.assign({ gender: p.gender || '' }, baseRow()), { onConflict: 'user_id' });
    if (up.error && isMissingColumn(up.error)) {
      up = await sb.from('profiles').upsert(baseRow(), { onConflict: 'user_id' });
    }
    if (up.error) throw up.error;
  } catch (e) { /* offline — local copy is the source of truth */ }
}
function themedOrLetterAvatar(id) {
  return DEFAULT_AVATARS.some(a => a.id === id) ? { type: 'default', id: id } : { type: 'letter' };
}
// Adopt the photo a winning cloud row points at (download once, keep local).
async function adoptCloudPhoto(sb, p, row) {
  const want = row.avatar_path || '';
  if (want && want === p.avatarCloudPath && p.avatar.type === 'upload' && p.avatar.dataUrl) return;
  if (want && sb.storage) {
    try {
      const dl = await sb.storage.from('avatars').download(want);
      if (!dl.error && dl.data) {
        p.avatar = { type: 'upload', dataUrl: await blobToDataUrl(dl.data) };
        p.avatarCloudPath = want;
        return;
      }
    } catch (e) { /* fall through to the fallback */ }
  }
  p.avatar = themedOrLetterAvatar(row.avatar_id);
  p.avatarCloudPath = '';
}
// Two-way sync with the profiles table. Newer updatedAt wins, either direction.
async function syncCloudProfile() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return;
  try {
    // v178: prefer the gender column, fall back to the old column set when
    // the database hasn't been migrated yet.
    const COLS_FULL = 'first_name,last_name,avatar_id,avatar_path,updated_at,gender';
    const COLS_BASIC = 'first_name,last_name,avatar_id,avatar_path,updated_at';
    let res = await sb.from('profiles').select(COLS_FULL).eq('user_id', cloudUser.id).maybeSingle();
    if (res.error && isMissingColumn(res.error)) {
      res = await sb.from('profiles').select(COLS_BASIC).eq('user_id', cloudUser.id).maybeSingle();
    }
    if (res.error) throw res.error;
    const row = res.data || null;
    const p = loadProfile();
    const localTs = p.updatedAt || 0;
    const remoteTs = row ? (Date.parse(row.updated_at) || 0) : 0;
    if (row && remoteTs > localTs) {
      p.firstName = row.first_name || '';
      p.lastName = row.last_name || '';
      if (['f', 'm', 'other'].indexOf(row.gender) !== -1) p.gender = row.gender;
      await adoptCloudPhoto(sb, p, row);
      p.updatedAt = remoteTs;
      saveProfile(p);
      renderTopbar();
      if (view === 'profile') renderProfile();
    } else {
      const hasContent = !!(p.firstName || p.lastName || p.avatar.type !== 'letter' || localTs > 0);
      if (hasContent && (!row || localTs > remoteTs)) await pushCloudProfile(p);
    }
  } catch (e) { /* offline — try again next sync */ }
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
    : '<span class="menu-avatar-img letter dim">' + icon('user') + '</span>';
  btn.title = signedIn() ? 'Account — ' + cloudUser.email : 'Menu';
  closeMenu();
}
function menuItems() {
  if (signedIn()) {
    const items = [
      { id: 'profile', icon: 'user', label: 'Profile' },
      { id: 'settings', icon: 'gear', label: 'Settings' },
    ];
    // v119: the Observatory menu entry appears only for admins (resolved
    // per-session by refreshAdminStatus); the view itself re-gates anyway.
    if (typeof isAppAdmin !== 'undefined' && isAppAdmin) {
      items.push({ id: 'observatory', icon: 'chart', label: 'Observatory' });
    }
    items.push({ id: 'logout', icon: 'logout', label: 'Logout' });
    return items;
  }
  const items = [{ id: 'settings', icon: 'gear', label: 'Settings' }];
  // v204: signed-out mode is gone — a signed-out user is always on the gate,
  // which is the sign-in screen, so there is no separate menu item for it.
  return items;
}
function openMenu() {
  const pop = document.getElementById('menu-pop');
  if (!pop) return;
  pop.innerHTML =
    (signedIn() ? '<div class="menu-email">' + esc(cloudUser.email) + '</div>' : '') +
    menuItems().map(m =>
      '<button data-m="' + m.id + '"><span class="mi">' + icon(m.icon) + '</span>' + m.label + '</button>').join('');
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
  else if (id === 'observatory') go('admin'); // v119: admin-gated in renderAdmin()
  else if (id === 'logout') {
    // v350: no native confirm() — it blocks the renderer (Advisor triage).
    // Matches Settings → Account logout (no confirm); low-risk action.
    cloudSignOut();
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
          '<span class="pf-upload">' + icon('camera') + '</span></button>' +
        '<button class="pf-pick' + (p.avatar.type === 'letter' ? ' sel' : '') + '" data-av="__letter" title="Just my initial" aria-label="Just my initial">' +
          '<span class="pf-letter">' + esc(avatarLetter(p)) + '</span></button>' +
        '</div>' +
        '<input type="file" id="pf-file" accept="image/*" hidden>' +
      '</div>' +
      '<div class="field"><label>First name</label>' +
      '<input id="pf-first" class="text-input" value="' + esc(p.firstName) + '" autocomplete="given-name" maxlength="40"></div>' +
      '<div class="field"><label>Last name</label>' +
      '<input id="pf-last" class="text-input" value="' + esc(p.lastName) + '" autocomplete="family-name" maxlength="40"></div>' +
      '<div class="field"><label>Gender</label>' +
      '<div class="seg" id="pf-gender" style="grid-template-columns:1fr 1fr 1fr">' +
      '<button type="button" data-g="f" class="' + (p.gender === 'f' ? 'active' : '') + '">Female</button>' +
      '<button type="button" data-g="m" class="' + (p.gender === 'm' ? 'active' : '') + '">Male</button>' +
      '<button type="button" data-g="other" class="' + (p.gender === 'other' ? 'active' : '') + '">Other</button></div>' +
      '<p class="note" style="margin:6px 0 0">Sets how the home screen greets you. Tap again to clear.</p></div>' +
      '<div class="field"><label>Email</label>' +
      '<input class="text-input" value="' + esc(email) + '" disabled></div>' +
      '<button class="btn block" id="pf-save">Save profile</button>' +
      '<p class="note">Your name, themed avatar, and profile picture sync to your cloud account when you\'re signed in, so they follow you across devices.</p>' +
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
    if (av.type === 'upload') np.avatarCloudPath = ''; // new photo → re-upload
    touchProfile(np);
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
    const gsel = document.querySelector('#pf-gender button.active');
    np.gender = gsel ? gsel.dataset.g : '';
    touchProfile(np);
    pushCloudProfile(np);
    renderTopbar();
    toast('Profile saved ✨');
  });
  // v177: gender picker toggles (tap the active one to clear back to unset)
  const gbtns = Array.from(document.querySelectorAll('#pf-gender button'));
  gbtns.forEach(b => b.addEventListener('click', () => {
    const was = b.classList.contains('active');
    gbtns.forEach(x => x.classList.remove('active'));
    if (!was) b.classList.add('active');
  }));
}

renderTopbar();
