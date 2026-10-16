'use strict';

/* ---------------- profile + account menu (v37) ---------------- */

// Default avatar choices — dark romance / romantasy / BookTok themed.
// v542: avatars ship in SETS. Registration here is the allowlist — profile
// sync validates ids against this list, so an id is choosable (and syncable)
// only once it lands here. `premium` is an internal catalog flag only during
// alpha: premium sets are flagged, never locked. Ids are never reused.
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export const AVATAR_SETS = [
  { key: 'classics', name: 'Libram Classics' },
  { key: 'stormrider', name: 'Stormrider' },
  { key: 'voidsignal', name: 'Voidsignal' },
];
export const DEFAULT_AVATARS = [
  { id: 'rose', label: 'Dark Rose', src: 'img/avatars/avatar-rose.webp', set: 'classics' },
  { id: 'moon', label: 'Moon & Dagger', src: 'img/avatars/avatar-moon.webp', set: 'classics' },
  { id: 'dragon', label: 'Dragon', src: 'img/avatars/avatar-dragon.webp', set: 'classics' },
  { id: 'raven', label: 'Raven', src: 'img/avatars/avatar-raven.webp', set: 'classics' },
  { id: 'book', label: 'Spellbook', src: 'img/avatars/avatar-book.webp', set: 'classics' },
  { id: 'crown', label: 'Thorn Crown', src: 'img/avatars/avatar-crown.webp', set: 'classics' },
  // v542: Stormrider — original dragon-rider art, inspired-by only.
  { id: 'onyxdragon', label: 'Black Dragon', src: 'img/avatars/avatar-onyxdragon.webp', set: 'stormrider', premium: true },
  { id: 'golddragon', label: 'Gold Dragon', src: 'img/avatars/avatar-golddragon.webp', set: 'stormrider', premium: true },
  { id: 'egg', label: 'Dragon Egg', src: 'img/avatars/avatar-egg.webp', set: 'stormrider', premium: true },
  { id: 'daggers', label: 'Crossed Daggers', src: 'img/avatars/avatar-daggers.webp', set: 'stormrider', premium: true },
  { id: 'goggles', label: 'Flight Goggles', src: 'img/avatars/avatar-goggles.webp', set: 'stormrider', premium: true },
  { id: 'parapet', label: 'Parapet at Dusk', src: 'img/avatars/avatar-parapet.webp', set: 'stormrider', premium: true },
  { id: 'ring', label: 'Signet Ring', src: 'img/avatars/avatar-ring.webp', set: 'stormrider', premium: true },
  { id: 'tabby', label: "Rider's Tabby", src: 'img/avatars/avatar-tabby.webp', set: 'stormrider', premium: true },
  // v544: Voidsignal — original Darknet-inspired art, inspired-by only
  // (network webs, AR overlays, circuits, cornfields — no space imagery).
  { id: 'darknet', label: 'Darknet Web', src: 'img/avatars/avatar-darknet.webp', set: 'voidsignal', premium: true },
  { id: 'visor', label: 'AR Visor', src: 'img/avatars/avatar-visor.webp', set: 'voidsignal', premium: true },
  { id: 'daemon', label: 'Daemon Sigil', src: 'img/avatars/avatar-daemon.webp', set: 'voidsignal', premium: true },
  { id: 'cornsignal', label: 'Cornfield Signal', src: 'img/avatars/avatar-cornsignal.webp', set: 'voidsignal', premium: true },
  { id: 'drone', label: 'Drone', src: 'img/avatars/avatar-drone.webp', set: 'voidsignal', premium: true },
  { id: 'circuitkey', label: 'Circuit Key', src: 'img/avatars/avatar-circuitkey.webp', set: 'voidsignal', premium: true },
  { id: 'strands', label: 'Data Strands', src: 'img/avatars/avatar-strands.webp', set: 'voidsignal', premium: true },
  { id: 'silo', label: 'Silo Broadcast', src: 'img/avatars/avatar-silo.webp', set: 'voidsignal', premium: true },
];

// Profile storage: one slot per user id ('offline' when not signed in).
export function profileKey() {
  return 'spicyshelves.profile.' + (cloudUser ? cloudUser.id : 'offline');
}
export function blankProfile() {
  // v522: bio + favGenres — the shareable profile content the Circle &
  // privacy "bio & favourite genres" toggle governs.
  // v550: handle (the chosen public identity; written ONLY by the
  // claim_handle RPC, never by this sync) + findable (the separate
  // opt-in to being looked up by it; a plain posture flag that rides
  // the sync ladder like share_bio).
  return { firstName: '', lastName: '', gender: '', avatar: { type: 'letter' }, avatarCloudPath: '', updatedAt: 0, bio: '', favGenres: [], handle: '', findable: false };
}
export function loadProfile() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(profileKey()) || 'null'); } catch (e) {}
  const base = blankProfile();
  if (!p || typeof p !== 'object') return base;
  base.firstName = String(p.firstName || '');
  base.lastName = String(p.lastName || '');
  base.gender = ['f', 'm', 'other'].indexOf(p.gender) !== -1 ? p.gender : ''; // v177: greeting term
  base.avatarCloudPath = String(p.avatarCloudPath || '');
  base.updatedAt = Number(p.updatedAt) || 0;
  base.bio = String(p.bio || '').slice(0, 240);
  base.favGenres = Array.isArray(p.favGenres)
    ? p.favGenres.map(g => String(g || '').trim()).filter(Boolean).slice(0, 8) : [];
  base.handle = (typeof p.handle === 'string' && /^[a-z0-9_]{3,20}$/.test(p.handle)) ? p.handle : '';
  base.findable = p.findable === true;
  if (p.avatar && typeof p.avatar === 'object') {
    if (p.avatar.type === 'default' && DEFAULT_AVATARS.some(a => a.id === p.avatar.id)) base.avatar = { type: 'default', id: p.avatar.id };
    else if (p.avatar.type === 'sticker' && stickerAvatarValid(p.avatar.id)) base.avatar = { type: 'sticker', id: p.avatar.id };
    else if (p.avatar.type === 'upload' && p.avatar.dataUrl) base.avatar = { type: 'upload', dataUrl: p.avatar.dataUrl };
  }
  return base;
}
export function saveProfile(p) {
  try { localStorage.setItem(profileKey(), JSON.stringify(p)); } catch (e) {}
}
// Stamp a user edit and save it. The stamp is what last-write-wins sync
// compares across devices.
export function touchProfile(p) {
  p.updatedAt = Date.now();
  saveProfile(p);
  return p;
}
// dataURL <-> Blob helpers for the avatar bucket (btoa/atob/arrayBuffer exist
// in both browsers and Node, so the test suite can exercise the real path).
export function dataUrlToBlob(dataUrl) {
  const parts = String(dataUrl).split(',');
  const type = (parts[0].match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(parts[1] || '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type });
}
export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return 'data:' + (blob.type || 'image/jpeg') + ';base64,' + btoa(bin);
}
// One-time bridge: v37 briefly mirrored names into auth user_metadata.
// If this device never set a profile, carry those values forward once.
export function adoptLegacyMetadata(user) {
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
export function isMissingColumn(err) {
  if (!err) return false;
  if (/42703/i.test(String(err.code || ''))) return true;
  return /column .* does not exist/i.test(String(err.message || ''));
}
// Push this device's profile to the profiles table (best-effort). A newly
// picked photo is uploaded to the private `avatars` bucket first (one file
// per user, overwritten in place); the row just stores its path.
export async function pushCloudProfile(p) {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return { ok: false, error: null };
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
      avatar_id: cloudAvatarId(p),
      avatar_path: cloudPath,
      updated_at: new Date(p.updatedAt || Date.now()).toISOString()
    });
    // v522: three-tier upsert — full row (bio/genres included), then
    // without bio/genres, then the bare row — so a database missing any
    // of the newer columns still syncs names/avatars (the v178 pattern).
    // v550: findable rides the full tier only — and the handle NEVER
    // rides any tier: claim_handle is its only write path (a database
    // guard rejects handle writes from anywhere else).
    let up = await sb.from('profiles').upsert(
      Object.assign({ gender: p.gender || '', bio: p.bio || '', fav_genres: p.favGenres || [], findable: p.findable === true }, baseRow()), { onConflict: 'user_id' });
    if (up.error && isMissingColumn(up.error)) {
      up = await sb.from('profiles').upsert(
        Object.assign({ gender: p.gender || '' }, baseRow()), { onConflict: 'user_id' });
    }
    if (up.error && isMissingColumn(up.error)) {
      up = await sb.from('profiles').upsert(baseRow(), { onConflict: 'user_id' });
    }
    if (up.error) throw up.error;
    return { ok: true };
  } catch (e) {
    // v550: a server content-screen rejection (23514, from the v550
    // profiles_content_screen trigger) is NOT an offline blip — the
    // name or bio on the row was refused. Surface it honestly and
    // report the failure to the caller; every other error keeps the
    // quiet offline semantics (local copy is the source of truth).
    if (/profile content screened/i.test(String((e && e.message) || e || ''))) {
      toast('That name or bio can’t be used — please adjust it and save again.');
    }
    return { ok: false, error: e };
  }
}
/* ---- sticker avatars (v546): the Reader Portrait sticker library
   (js/228's PS_STICKER_SETS catalog) doubles as profile pictures.
   Persistence rides the same profiles.avatar_id text column as catalog
   avatars, under a namespaced id — 'stk:<theme-dir>/<file-stem>', e.g.
   'stk:velvet/velvet-a-01' — so a sticker id can never collide with a
   present or future catalog id (bare slugs: no prefix, no slash), and it
   resolves to its file with no lookup table. Unknown or stale ids fall
   back to the initial avatar exactly like bogus catalog ids. ---- */
export const STICKER_AVATAR_PREFIX = 'stk:';
export function stickerCatalog() {
  // js/228 loads after js/105; every real call site runs post-boot, and
  // the typeof guard keeps the first renderTopbar (end of this file,
  // before js/228 executes) safe — a sticker avatar just shows its
  // initial for that one paint and resolves on the next render.
  try { return (typeof PS_STICKER_SETS !== 'undefined' && PS_STICKER_SETS) ? PS_STICKER_SETS : null; }
  catch (e) { return null; }
}
export function parseStickerAvatarId(id) {
  if (typeof id !== 'string' || id.indexOf(STICKER_AVATAR_PREFIX) !== 0) return null;
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)-([ab])-(\d{2})$/.exec(id.slice(STICKER_AVATAR_PREFIX.length));
  if (!m || m[2] !== m[1]) return null; // the file stem repeats its theme dir
  return { theme: m[1], sheet: m[3], num: parseInt(m[4], 10), stem: m[2] + '-' + m[3] + '-' + m[4] };
}
/* Four shipped sheets are NOT numbered contiguously (some numbers were
   retired when the sets were cut): the catalog counts are right, the
   ranges are not. These explicit lists are the inventory truth for
   those sheets; every other sheet is contiguous 01..count. The
   sticker-avatars suite pins registry == disk inventory, so a future
   re-cut that changes the numbering fails loudly here. js/228's
   portrait-share rotation consumes these same lists (v552, #213). */
export const STICKER_SHEET_NUMBERS = {
  'briarthrone/b': [1, 2, 3, 5, 10, 11, 13, 14, 15, 18, 19, 20, 21],
  'light/a': [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  'midnight/b': [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13],
  'wisp/b': [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13]
};
export function stickerSheetNumbers(theme, sheet) {
  const explicit = STICKER_SHEET_NUMBERS[theme + '/' + sheet];
  if (explicit) return explicit;
  const cat = stickerCatalog();
  if (!cat || !cat[theme]) return [];
  const n = cat[theme][sheet === 'a' ? 0 : 1] || 0;
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out;
}
export function stickerAvatarValid(id) {
  const parts = parseStickerAvatarId(id);
  if (!parts || parts.num < 1) return false;
  const cat = stickerCatalog();
  if (!cat) return true; // catalog not loaded yet — rendering re-validates
  if (!cat[parts.theme]) return false;
  return stickerSheetNumbers(parts.theme, parts.sheet).indexOf(parts.num) !== -1;
}
export function stickerAvatarPath(parts) {
  return 'assets/stickers/cut-webp/' + parts.theme + '/' + parts.stem + '.webp';
}
export function stickerAvatarSrc(id) {
  if (!stickerAvatarValid(id)) return null;
  if (!stickerCatalog()) return null; // unresolved until js/228 lands; initial shows meanwhile
  return stickerAvatarPath(parseStickerAvatarId(id));
}
export function themedOrLetterAvatar(id) {
  if (id && DEFAULT_AVATARS.some(a => a.id === id)) return { type: 'default', id: id };
  if (id && stickerAvatarValid(id)) return { type: 'sticker', id: id };
  return { type: 'letter' };
}
/* Pure: the profiles.avatar_id value for a profile — the catalog id for
   painted avatars, the namespaced 'stk:' id for stickers, '' otherwise
   (uploads live in avatar_path; initials store nothing). */
export function cloudAvatarId(p) {
  if (!p || !p.avatar) return '';
  if (p.avatar.type === 'default' || p.avatar.type === 'sticker') return p.avatar.id || '';
  return '';
}
// Adopt the photo a winning cloud row points at (download once, keep local).
export async function adoptCloudPhoto(sb, p, row) {
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
export async function syncCloudProfile() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return;
  try {
    // v178: prefer the gender column, fall back to the old column set when
    // the database hasn't been migrated yet. v522: bio/fav_genres ride the
    // fullest tier, with the same missing-column fallback ladder.
    const COLS_FULL = 'first_name,last_name,avatar_id,avatar_path,updated_at,gender,bio,fav_genres,handle,findable';
    const COLS_MID = 'first_name,last_name,avatar_id,avatar_path,updated_at,gender';
    const COLS_BASIC = 'first_name,last_name,avatar_id,avatar_path,updated_at';
    let res = await sb.from('profiles').select(COLS_FULL).eq('user_id', cloudUser.id).maybeSingle();
    if (res.error && isMissingColumn(res.error)) {
      res = await sb.from('profiles').select(COLS_MID).eq('user_id', cloudUser.id).maybeSingle();
    }
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
      if (typeof row.bio === 'string') p.bio = row.bio.slice(0, 240);
      if (Array.isArray(row.fav_genres)) {
        p.favGenres = row.fav_genres.map(g => String(g || '').trim()).filter(Boolean).slice(0, 8);
      }
      // v550: only the full tier carries these keys — a lesser tier
      // (pre-v550 database) leaves the local values untouched.
      if ('handle' in row) {
        p.handle = (typeof row.handle === 'string' && /^[a-z0-9_]{3,20}$/.test(row.handle)) ? row.handle : '';
      }
      if ('findable' in row) p.findable = row.findable === true;
      await adoptCloudPhoto(sb, p, row);
      p.updatedAt = remoteTs;
      saveProfile(p);
      renderTopbar();
      // Hybrid: the identity editor lives on the Profile view.
      if (view === 'profile' && typeof renderProfile === 'function') renderProfile();
    } else {
      const hasContent = !!(p.firstName || p.lastName || p.avatar.type !== 'letter' || localTs > 0);
      if (hasContent && (!row || localTs > remoteTs)) await pushCloudProfile(p);
    }
  } catch (e) { /* offline — try again next sync */ }
}

export function avatarSrc(p) {
  if (!p) return null;
  if (p.avatar.type === 'upload' && p.avatar.dataUrl) return p.avatar.dataUrl;
  if (p.avatar.type === 'default') {
    const a = DEFAULT_AVATARS.find(x => x.id === p.avatar.id);
    if (a) return a.src;
  }
  if (p.avatar.type === 'sticker') return stickerAvatarSrc(p.avatar.id);
  return null;
}
export function avatarLetter(p) {
  const n = (p.firstName || '').trim();
  if (n) return n[0].toUpperCase();
  const e = (cloudUser && cloudUser.email) || '';
  return (e.trim()[0] || '•').toUpperCase();
}
export function avatarHTML(p, cls) {
  const src = avatarSrc(p);
  if (src) {
    // v546: sticker avatars carry .avatar-stk (contain rendering on the
    // disc, styles.css) plus the owner's initial for the load-failure
    // fallback below.
    if (p.avatar.type === 'sticker') {
      return '<img class="' + cls + ' avatar-stk" src="' + esc(src) + '" data-letter="' + esc(avatarLetter(p)) + '" alt="Profile picture">';
    }
    return '<img class="' + cls + '" src="' + esc(src) + '" alt="Profile picture">';
  }
  return '<span class="' + cls + ' letter">' + esc(avatarLetter(p)) + '</span>';
}
/* v546: a sticker avatar that can't be fetched (offline, or evicted from
   the count-capped runtime sticker cache) degrades to the initial —
   never a broken-image glyph. One capture-phase listener covers every
   surface avatarHTML renders; data-cav (js/195's friend marker) rides
   along so photo upgrades still find the node. */
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('error', (e) => {
    const t = e && e.target;
    if (!t || t.tagName !== 'IMG' || !t.classList || !t.classList.contains('avatar-stk')) return;
    const span = document.createElement('span');
    span.className = (t.className || '').replace('avatar-stk', '').trim() + ' letter';
    span.textContent = t.getAttribute('data-letter') || '•';
    const cav = t.getAttribute('data-cav');
    if (cav) span.setAttribute('data-cav', cav);
    if (t.parentNode) t.parentNode.replaceChild(span, t);
  }, true);
}
export const signedIn = () => !!(cloudUser && cloudUser.email);

/* ---- topbar + dropdown menu ---- */
export function renderTopbar() {
  const btn = document.getElementById('menu-btn');
  if (!btn) return;
  const p = loadProfile();
  btn.innerHTML = signedIn()
    ? avatarHTML(p, 'menu-avatar-img')
    : '<span class="menu-avatar-img letter dim">' + icon('user') + '</span>';
  btn.title = signedIn() ? 'Account — ' + cloudUser.email : 'Menu';
  closeMenu();
}
export function menuItems() {
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
export function openMenu() {
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
export function closeMenu() {
  const pop = document.getElementById('menu-pop');
  if (pop) { pop.hidden = true; pop.innerHTML = ''; }
}
export function menuAction(id) {
  closeMenu();
  // Hybrid: "Profile" is its own view again — the two menu doors lead
  // to two different rooms (Profile = identity + gifts; Settings = config).
  if (id === 'profile') go('profile');
  else if (id === 'settings') go('settings');
  else if (id === 'observatory') go('admin'); // v119: admin-gated in renderAdmin()
  else if (id === 'logout') {
    // v350: no native confirm() — it blocks the renderer (Advisor triage).
    // Matches Settings → Account logout (no confirm); low-risk action.
    cloudSignOut();
  }
}
export const _menuBtn = document.getElementById('menu-btn');
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
export function fileToAvatarDataURL(file) {
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
/* ---- the account form (v590 form; hybrid placement) ----
 * v590 (Variant B) folded this form into Settings → Account; the
 * hybrid (2026-10-16) moves the MOUNT back to the Profile view —
 * renderProfile below renders it and wireAccountForm wires it,
 * exactly as Settings did. Identity + handle + findable + the gift
 * address slot live here.
 * SAVE MODEL (stated on the surface): the form AUTOSAVES through one
 * commit — the v589 house pattern. Text fields debounce-commit 700ms
 * after the last keystroke; the discrete pickers (gender, findable)
 * commit at once through the same function. The age band is NOT part
 * of the form's data (it writes user_state instantly, as before), and
 * the handle keeps its own claim buttons (a claim, not a save). */
export function accountFormHTML() {
  const p = loadProfile();
  const bandNow = (typeof privacyState === 'function') ? privacyState().band : null;
  const email = (cloudUser && cloudUser.email) || '';
  const segBtn = (attrs, active, label) =>
    '<button type="button" ' + attrs + ' class="' + (active ? 'active' : '') + '" aria-pressed="' + (active ? 'true' : 'false') + '">' + label + '</button>';
  return '<p class="note" style="margin:0 0 10px">Your account details — changes save automatically.<span id="ac-savestate" role="status" style="margin-left:6px"></span></p>' +
    '<div class="pf-avatar-row">' + avatarHTML(p, 'pf-avatar') +
    '<div><button class="btn ghost sm" id="pf-change">Change picture</button>' +
    '<p class="note" style="margin:6px 0 0">Painted avatars, stickers, or your own photo — try them on first.</p></div></div>' +
    '<div class="field"><label for="pf-first">First name</label>' +
    '<input id="pf-first" class="text-input" value="' + esc(p.firstName) + '" autocomplete="given-name" maxlength="40"></div>' +
    '<div class="field"><label for="pf-last">Last name</label>' +
    '<input id="pf-last" class="text-input" value="' + esc(p.lastName) + '" autocomplete="family-name" maxlength="40"></div>' +
    '<div class="field"><label>Gender</label>' +
    '<div class="seg" id="pf-gender" role="group" aria-label="Gender" style="grid-template-columns:1fr 1fr 1fr">' +
    segBtn('data-g="f"', p.gender === 'f', 'Female') +
    segBtn('data-g="m"', p.gender === 'm', 'Male') +
    segBtn('data-g="other"', p.gender === 'other', 'Other') + '</div>' +
    '<p class="note" style="margin:6px 0 0">Sets how the home screen greets you. Tap again to clear.</p></div>' +
    // v524: age band — the owner's own setting only. It renders here
    // and NOWHERE else: never on the public projection, never as a
    // badge. Stored in user_state (js/230), applied instantly.
    '<div class="field"><label>Age group</label>' +
    '<div class="seg" id="pf-band" role="group" aria-label="Age group" style="grid-template-columns:1fr 1fr">' +
    segBtn('data-b="teen"', bandNow === 'teen', '13–17') +
    segBtn('data-b="adult"', bandNow === 'adult', '18+') + '</div>' +
    '<p class="note" style="margin:6px 0 0">Stored privately — never shown on your profile or to your circle. Choosing 13–17 for the first time turns on the content shield and starts your circle sharing closed; every setting stays yours to change afterwards.</p></div>' +
    '<div class="field"><label for="pf-bio">Bio</label>' +
    '<textarea id="pf-bio" class="text-input" rows="2" maxlength="240" placeholder="A line or two about your reading life">' + esc(p.bio || '') + '</textarea>' +
    '<p class="note" style="margin:6px 0 0">Shown to your circle only if “Profile bio &amp; favourite genres” is on in Settings → Circle &amp; privacy.</p></div>' +
    '<div class="field"><label for="pf-genres">Favourite genres</label>' +
    '<input id="pf-genres" class="text-input" value="' + esc((p.favGenres || []).join(', ')) + '" maxlength="200" placeholder="Romantasy, Gothic horror, Space opera">' +
    '<p class="note" style="margin:6px 0 0">Comma-separated, up to 8.</p></div>' +
    // v550: the handle — claimed/changed/cleared through its own
    // buttons (the claim RPC is the only write path), NOT through the
    // form commit. The block is built and wired by js/237.
    '<div class="field"><label>Handle</label>' +
    '<div id="pf-handle-box">' + (typeof handleEditorHTML === 'function' ? handleEditorHTML(p) : '') + '</div></div>' +
    '<div class="field" id="pf-findable-field"><label>Findable by handle</label>' +
    '<div class="seg" id="pf-findable" role="group" aria-label="Findable by handle" data-disabled="' + (p.handle ? '0' : '1') + '" style="grid-template-columns:1fr 1fr">' +
    '<button type="button" data-f="1" class="' + (p.findable ? 'active' : '') + '" aria-pressed="' + (p.findable ? 'true' : 'false') + '"' + (p.handle ? '' : ' disabled') + '>On</button>' +
    '<button type="button" data-f="0" class="' + (!p.findable ? 'active' : '') + '" aria-pressed="' + (!p.findable ? 'true' : 'false') + '"' + (p.handle ? '' : ' disabled') + '>Off</button></div>' +
    '<p class="note" style="margin:6px 0 0">' + (p.handle
      ? 'When on, anyone who knows your exact handle (@' + esc(p.handle) + ') can find you and send a connection request — which you can accept or decline. There’s no browsing and no partial search: the exact handle only. Off is the default.'
      : 'Set a handle first — then you can choose whether people who know it can find you by it.') + '</p></div>' +
    '<div class="field"><label for="pf-email">Email</label>' +
    '<input id="pf-email" class="text-input" value="' + esc(email) + '" disabled></div>' +
    '<p class="note">Your name, themed avatar, and profile picture sync to your cloud account when you\'re signed in, so they follow you across devices.</p>' +
    // v582/v588: the Gift a Book address editor lives here, with the
    // rest of the user's own details. Like the handle block, it saves
    // through its own buttons (validation-gated), not the form
    // commit. Built and wired by js/243's fillGiftAddress; the slot
    // stays empty when signed out, unsupported, or teen-band.
    '<div id="pf-giftaddr-slot"></div>';
}

export function wireAccountForm(root) {
  const scope = root || document;
  // v546: the picker is the Collections + Fitting Room sheet (js/236).
  const changeBtn = scope.querySelector('#pf-change');
  if (changeBtn) changeBtn.addEventListener('click', () => {
    if (typeof openAvatarPicker === 'function') openAvatarPicker();
  });
  // v550: the handle editor block (js/237).
  if (typeof wireHandleEditor === 'function') wireHandleEditor();
  // v582: the gift address block (js/243) — fills only when signed in,
  // gifts are supported, and the account is not teen-band.
  const giftSlot = scope.querySelector('#pf-giftaddr-slot');
  if (giftSlot && typeof fillGiftAddress === 'function') fillGiftAddress(giftSlot);

  /* --- the ONE commit path --- */
  const statusEl = scope.querySelector('#ac-savestate');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  let timer = null, savedTimer = null;
  const commit = () => {
    timer = null;
    const firstEl = scope.querySelector('#pf-first');
    if (!firstEl) return; // the form left the DOM before the debounce landed
    const np = loadProfile();
    np.firstName = firstEl.value.trim().slice(0, 40);
    const lastEl = scope.querySelector('#pf-last');
    np.lastName = lastEl ? lastEl.value.trim().slice(0, 40) : '';
    const gsel = scope.querySelector('#pf-gender button.active');
    np.gender = gsel ? gsel.dataset.g : '';
    const bioEl = scope.querySelector('#pf-bio');
    if (bioEl) np.bio = bioEl.value.trim().slice(0, 240);
    const genEl = scope.querySelector('#pf-genres');
    if (genEl) np.favGenres = genEl.value.split(',').map(g => g.trim()).filter(Boolean).slice(0, 8);
    // v550: findable rides the commit (it is a posture flag on the
    // profile); the handle itself never does — js/237's claim buttons
    // own it. No handle → findable is meaningless and forced off.
    const fsel = scope.querySelector('#pf-findable button.active');
    if (fsel) np.findable = fsel.dataset.f === '1';
    if (!np.handle) np.findable = false;
    // v550: screen the name fields + bio BEFORE anything persists —
    // the server trigger (migration v550) is the backstop, this is
    // the immediate, honest answer. A screen hit holds the WHOLE
    // commit: nothing persists, and the reason stays on the surface.
    if (typeof profileContentScreenHit === 'function') {
      const hitField = profileContentScreenHit(np);
      if (hitField) {
        setStatus(hitField === 'bio'
          ? 'That bio can’t be used — please adjust it.'
          : 'That name can’t be used — please adjust it.');
        return;
      }
    }
    touchProfile(np);
    pushCloudProfile(np);
    renderTopbar();
    setStatus('Saved');
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => setStatus(''), 2000);
  };
  const schedule = () => {
    setStatus('Saving…');
    if (timer) clearTimeout(timer);
    timer = setTimeout(commit, 700);
  };
  ['#pf-first', '#pf-last', '#pf-bio', '#pf-genres'].forEach(sel => {
    const el = scope.querySelector(sel);
    if (el) el.addEventListener('input', schedule);
  });
  // Findable seg: radio behaviour; a discrete choice commits at once
  // through the same path. Disabled buttons (no handle) stay inert.
  const fbtns = Array.from(scope.querySelectorAll('#pf-findable button'));
  fbtns.forEach(b => b.addEventListener('click', () => {
    if (b.disabled) return;
    fbtns.forEach(x => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    commit();
  }));
  // v524: band picker — radio behavior, applied INSTANTLY through
  // js/230 (user_state), never through the form: the band is not
  // profile data. Only a live selection writes; the first teen
  // selection applies the teen starting positions exactly once.
  const bbtns = Array.from(scope.querySelectorAll('#pf-band button'));
  bbtns.forEach(b => b.addEventListener('click', () => {
    bbtns.forEach(x => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (typeof setAgeBand === 'function') setAgeBand(b.dataset.b);
  }));
  // v177: gender picker toggles (tap the active one to clear back to
  // unset); a discrete choice commits at once through the same path.
  const gbtns = Array.from(scope.querySelectorAll('#pf-gender button'));
  gbtns.forEach(b => b.addEventListener('click', () => {
    const was = b.classList.contains('active');
    gbtns.forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
    if (!was) { b.classList.add('active'); b.setAttribute('aria-pressed', 'true'); }
    commit();
  }));
}

/* ---- the Profile view (hybrid, 2026-10-16) ----
 * Restored as a real view after v590 folded it into Settings → Account:
 * the User's ruling is "Profile holds me + gifts, Settings holds
 * config." The view mounts the identity form (accountFormHTML, wired
 * by wireAccountForm — the autosave behaviour is byte-identical, only
 * the mount moved) and, for signed-in readers, the reunited gift
 * cluster (js/243's giftClusterHTML) under it.
 * The cluster's See-claims seg + gift slot are wired by js/195's
 * wireCirclePrivacyPanel against THIS view (prefix 'pf') once the
 * privacy state loads — the same wire path the panel's own doors use,
 * so the panel state seeded from the loaded profile is what a
 * gift-seg save folds into the row. Until the load lands (or if it
 * fails) the cluster stays hidden: giftSupported's fail-closed rule
 * is js/195's reveal, and an unwired cluster never appears. The
 * titled card around the cluster (#pf-giftcard) renders hidden
 * with it and shares its fate — js/195's reveal shows both at the
 * same moment, and its fail-closed paths drop both — so a refused
 * load never leaves an empty titled card on the page. */
export function renderProfile() {
  const htmlGiftCluster = (signedIn() && typeof giftClusterHTML === 'function') ? giftClusterHTML('pf', false) : '';
  setView(
    '<div class="view-head"><button class="btn ghost sm" id="pf-back">← Back</button>' +
    '<h2 class="serif">Profile</h2></div>' +
    '<div class="pf-card">' + accountFormHTML() + '</div>' +
    (htmlGiftCluster
      ? '<div class="pf-card" id="pf-giftcard" style="margin-top:12px" hidden><h3 class="set-sub serif" style="margin-top:0">Gift a Book</h3>' +
        htmlGiftCluster + '</div>'
      : '')
  );
  wireAccountForm(document.getElementById('view'));
  document.getElementById('pf-back').addEventListener('click', () => go('library'));
  (async () => {
    if (!signedIn() || typeof circlePrivacy !== 'function' || typeof wireCirclePrivacyPanel !== 'function') return;
    let priv;
    try { priv = await circlePrivacy(); } catch (e) { return; }
    if (view !== 'profile') return; // navigated away mid-load — never wire a dead tree
    const root = document.getElementById('view');
    if (!root || !root.querySelector('#pf-giftwrap')) return;
    wireCirclePrivacyPanel(root, priv, 'pf');
    // The cluster rendered before the saved state was known; bring
    // its See-claims seg in step with what actually loaded.
    const gcSeg = document.getElementById('pf-giftclaims');
    if (gcSeg) gcSeg.querySelectorAll('button').forEach(x => {
      const on = (x.dataset.v === '1') === (priv.giftClaims === true);
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  })();
}

renderTopbar();

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this file
   can see them. The consumers — js/090-sync.js, js/095-gate.js,
   js/120-favorites.js, js/180-settings.js, js/195-coven.js,
   js/199-admin.js, js/200-boot.js, js/228-portrait-share.js,
   js/236-sticker-picker.js and js/237-handles.js — reach these names at
   runtime, so the bridge republishes exactly the pre-conversion public
   surface on window. Bare-name lookups in classic scripts resolve through
   the global object, so the caller needs no changes. Module scripts are
   deferred, so the bridge is in place before any consumer can run. Remove a
   name from this bridge only when its last classic caller is gone.
 */
window.AVATAR_SETS = AVATAR_SETS;
window.DEFAULT_AVATARS = DEFAULT_AVATARS;
window.profileKey = profileKey;
window.blankProfile = blankProfile;
window.loadProfile = loadProfile;
window.saveProfile = saveProfile;
window.touchProfile = touchProfile;
window.dataUrlToBlob = dataUrlToBlob;
window.blobToDataUrl = blobToDataUrl;
window.adoptLegacyMetadata = adoptLegacyMetadata;
window.isMissingColumn = isMissingColumn;
window.pushCloudProfile = pushCloudProfile;
window.STICKER_AVATAR_PREFIX = STICKER_AVATAR_PREFIX;
window.stickerCatalog = stickerCatalog;
window.parseStickerAvatarId = parseStickerAvatarId;
window.STICKER_SHEET_NUMBERS = STICKER_SHEET_NUMBERS;
window.stickerSheetNumbers = stickerSheetNumbers;
window.stickerAvatarValid = stickerAvatarValid;
window.stickerAvatarPath = stickerAvatarPath;
window.stickerAvatarSrc = stickerAvatarSrc;
window.themedOrLetterAvatar = themedOrLetterAvatar;
window.cloudAvatarId = cloudAvatarId;
window.adoptCloudPhoto = adoptCloudPhoto;
window.syncCloudProfile = syncCloudProfile;
window.avatarSrc = avatarSrc;
window.avatarLetter = avatarLetter;
window.avatarHTML = avatarHTML;
window.signedIn = signedIn;
window.renderTopbar = renderTopbar;
window.menuItems = menuItems;
window.openMenu = openMenu;
window.closeMenu = closeMenu;
window.menuAction = menuAction;
window._menuBtn = _menuBtn;
window.fileToAvatarDataURL = fileToAvatarDataURL;
window.accountFormHTML = accountFormHTML;
window.wireAccountForm = wireAccountForm;
window.renderProfile = renderProfile;
