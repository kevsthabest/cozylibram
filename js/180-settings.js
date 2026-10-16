'use strict';

/* ---------------- backup view ---------------- */
/* ---------------- settings groups (v117) ---------------- */
// IA (v590, Variant B — one Account & Settings surface; the separate
// Profile view is gone): Account / Library / Reading / Appearance /
// Offline / Privacy / About. The Account group leads with sign-in,
// then the identity form (js/105's accountFormHTML), the reunited gift
// cluster (js/243), and Circle & privacy (the shared js/195 panel).
// (Metadata group removed v476 — enrichment now runs automatically in
// the background; see autoEnrichSweep + boot sequence.)
// Groups render directly as <details> cards (no post-hoc DOM
// wrapping). v590: groups START COLLAPSED — Account open, the rest
// closed — and the choice is NOT persisted: the old per-device
// open-state record (spicyshelves.setgroups, a frozen v518 key) is no
// longer read or written, so first paint is never a 97-control wall.
function setGroupShell(iconName, title, tag, inner, idx, openIdx) {
  return '<details class="set-group"' + (openIdx.indexOf(idx) !== -1 ? ' open' : '') + '>' +
    '<summary class="section serif"><span class="set-st"><span class="set-tt">' +
    icon(iconName) + ' ' + esc(title) + '</span>' +
    '<small class="set-tag">' + esc(tag) + '</small></span></summary>' +
    '<div class="set-body">' + inner + '</div></details>';
}

function setSub(t) {
  return '<h3 class="set-sub serif">' + esc(t) + '</h3>';
}

/* ---- v416 (P1/P2/P3/P4): visual theme gallery + detail sheet ----
   Replaces the blind theme dropdown. Tapping a card live-previews the theme
   app-wide and opens the detail sheet; closing without "Use theme" reverts. */
let tsSnapshot = null;   // { theme, accent } captured before previewing
let tsPreviewTheme = null;
let tsToken = null;      // v535: overlay-history token for the theme sheet
let tsPreviewAccent = null; // null = theme's designed default

/* Social section name shown on theme cards. User's call (2026-10-11):
   always "The Hearth" — the old per-theme names are retired. */
function tsCovenDisplay() {
  return 'The Hearth';
}
function themeCardHTML(th) {
  const pv = themePreview(th.key);
  const active = getTheme() === th.key;
  let inSeason = false;
  try { inSeason = !!th.season && typeof shelfDefaultSeason === 'function' && shelfDefaultSeason() === th.season; } catch (e) {}
  // v423: premium badge (unlocked during alpha — no paywall, just the flag).
  const isPrem = !!th.premium;
  return '<button class="tcard' + (active ? ' sel' : '') + '" data-th="' + th.key + '"' +
    ' aria-label="' + esc(th.name) + ' theme' + (isPrem ? ', premium' : '') + '">' +
    (inSeason ? '<span class="seasonbadge">IN SEASON</span>' : '') +
    (isPrem ? '<span class="prembadge">PREMIUM</span>' : '') +
    '<span class="mini" style="background:' + pv.bg + '">' +
      '<span class="mcard" style="background:' + pv.card + ';display:block">' +
        '<span class="mline" style="background:' + pv.ink + ';width:70%;display:block"></span>' +
        '<span class="mline" style="background:' + pv.muted + ';width:45%;display:block"></span>' +
      '</span>' +
      '<span class="mpill" style="background:' + pv.accent + '"></span>' +
    '</span>' +
    '<span class="tmeta"><b>' + esc(th.name) + '</b><span>' + esc(tsCovenDisplay()) + '</span></span>' +
    (active ? '<span class="check">✓</span>' : '') +
  '</button>';
}
function themeGalleryHTML() {
  const core = THEMES.filter(t => !t.season && !t.premium).map(themeCardHTML).join('');
  const seasonal = THEMES.filter(t => t.season).map(themeCardHTML).join('');
  // v423: premium packs get their own group. Wisp shows one card (Daybreak);
  // the Firefly Night variant is picked via the toggle in its detail sheet.
  const premium = THEMES.filter(t => t.premium && t.key !== 'wisp-night').map(themeCardHTML).join('');
  return '<div class="tgroup-label">Core</div><div class="tgrid">' + core + '</div>' +
    '<div class="tgroup-label">Seasonal</div><div class="tgrid">' + seasonal + '</div>' +
    '<div class="tgroup-label">Premium</div><div class="tgrid">' + premium + '</div>' +
    '<p class="note">Premium packs are unlocked during the alpha — no paywall yet.</p>';
}
function tsSheetHTML(th) {
  const pv = themePreview(th.key);
  const pairs = themeAccentPairings(th.key);
  const defA = themeDefaultAccent(th.key);
  const aByKey = k => ACCENTS.find(x => x.key === k) || { name: k, color: '#888' };
  const pairBtns = pairs.map(k => {
    const a = aByKey(k);
    return '<button class="pair' + (k === defA ? ' sug' : '') + '" data-a="' + k + '">' +
      '<i style="background:' + a.color + '"></i>' + esc(a.name) +
      (k === defA ? '<span class="def">default</span>' : '') + '</button>';
  }).join('');
  const swatches = ACCENTS.map(a =>
    '<button class="sw" data-a="' + a.key + '" style="--sw:' + a.color + '"' +
    ' title="' + esc(a.name) + '" aria-label="' + esc(a.name) + ' accent"></button>').join('');
  // v423: Wisp Daybreak / Firefly Night variant toggle.
  const wispToggle = (th.key === 'wisp' || th.key === 'wisp-night')
    ? '<div class="tgroup-label" style="margin-top:2px">Variant</div>' +
      '<div class="seg" id="tsWispVar" style="grid-template-columns:1fr 1fr">' +
      '<button data-v="wisp" class="' + (th.key === 'wisp' ? 'active' : '') + '">' + icon('sun') + ' Daybreak</button>' +
      '<button data-v="wisp-night" class="' + (th.key === 'wisp-night' ? 'active' : '') + '">' + icon('moon') + ' Firefly Night</button>' +
      '</div>'
    : '';
  return '<div class="tsheet-wrap" id="tsSheetWrap">' +
    '<div class="tsheet-scrim" id="tsScrim"></div>' +
    '<div class="tsheet" role="dialog" aria-modal="true" aria-label="' + esc(th.name) + ' theme details">' +
      '<div class="bigprev" style="background:' + pv.bg + '">' +
        '<div class="bcard2" style="background:' + pv.card + '">' +
          '<div class="bline" style="background:' + pv.ink + ';width:75%"></div>' +
          '<div class="bline" style="background:' + pv.muted + ';width:50%"></div>' +
        '</div>' +
        '<div class="brow"><span class="bchip" style="background:' + pv.accent + '">Read</span>' +
        '<span class="bchip" style="background:' + pv.card + ';color:' + pv.muted + '">TBR</span></div>' +
      '</div>' +
      '<h3>' + esc(th.name) + '</h3>' +
      '<div class="cov">Your social circle: <b>' + esc(tsCovenDisplay()) + '</b></div>' +
      wispToggle +
      '<div class="tgroup-label" style="margin-top:2px">Accent · <span id="tsAccentName" style="color:var(--ink);text-transform:none;letter-spacing:0"></span></div>' +
      '<div class="pairrow" id="tsPairs">' + pairBtns + '</div>' +
      '<div class="swatches" id="tsSwatches" style="flex-wrap:wrap">' + swatches + '</div>' +
      '<button class="btn block" id="tsUse" style="margin-top:14px">Use ' + esc(th.name) + '</button>' +
      '<button class="btn ghost block sm" id="tsResetAccent" style="margin-top:8px">Reset accent to theme default</button>' +
    '</div></div>';
}
function tsApplyPreview() {
  document.documentElement.dataset.theme = tsPreviewTheme;
  if (tsPreviewAccent) document.documentElement.dataset.accent = tsPreviewAccent;
  else document.documentElement.removeAttribute('data-accent');
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute('content', themeMeta(tsPreviewTheme));
  try { if (typeof refreshCovenNav === 'function') refreshCovenNav(); } catch (e) {}
  tsRefreshSheetAccents();
  document.querySelectorAll('.tcard').forEach(c =>
    c.classList.toggle('sel', c.dataset.th === tsPreviewTheme));
}
function tsRefreshSheetAccents() {
  if (!tsPreviewTheme) return;
  const cur = tsPreviewAccent || themeDefaultAccent(tsPreviewTheme);
  const nameEl = document.getElementById('tsAccentName');
  if (nameEl) {
    const a = ACCENTS.find(x => x.key === cur);
    nameEl.textContent = (a ? a.name : cur) + (tsPreviewAccent ? '' : ' (theme default)');
  }
  document.querySelectorAll('#tsPairs .pair').forEach(b =>
    b.classList.toggle('sel', b.dataset.a === cur));
  document.querySelectorAll('#tsSwatches .sw').forEach(b =>
    b.classList.toggle('active', b.dataset.a === cur));
}
function tsBeginPreview(themeKey) {
  if (!tsSnapshot) tsSnapshot = { theme: getTheme(), accent: getAccent() };
  tsPreviewTheme = themeKey;
  tsPreviewAccent = null; // preview the theme's designed look first
  tsApplyPreview();
}
function tsOpenSheet(th) {
  tsCloseSheet();
  tsBeginPreview(th.key);
  document.body.insertAdjacentHTML('beforeend', tsSheetHTML(th));
  tsRefreshSheetAccents();
  document.getElementById('tsScrim').addEventListener('click', tsRevert);
  document.getElementById('tsUse').addEventListener('click', tsConfirm);
  document.getElementById('tsResetAccent').addEventListener('click', () => {
    tsPreviewAccent = null; tsApplyPreview();
  });
  // v423: Wisp Daybreak / Firefly Night variant toggle — swaps the previewed
  // theme (and its accent pairings) without closing the sheet.
  document.querySelectorAll('#tsWispVar button').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#tsWispVar button').forEach(x =>
        x.classList.toggle('active', x === b));
      tsPreviewTheme = b.dataset.v;
      tsPreviewAccent = null;
      tsApplyPreview();
      const th2 = THEMES.find(t => t.key === tsPreviewTheme) || { name: tsPreviewTheme };
      const h3 = document.querySelector('#tsSheetWrap .tsheet h3');
      if (h3) h3.textContent = th2.name;
      const useBtn = document.getElementById('tsUse');
      if (useBtn) useBtn.textContent = 'Use ' + th2.name;
      const covEl = document.querySelector('#tsSheetWrap .tsheet .cov');
      if (covEl) covEl.innerHTML = 'Your social circle: <b>' + esc(tsCovenDisplay()) + '</b>';
      const pairsEl = document.getElementById('tsPairs');
      if (pairsEl) {
        const pairs = themeAccentPairings(tsPreviewTheme);
        const defA = themeDefaultAccent(tsPreviewTheme);
        const aByKey = k => ACCENTS.find(x => x.key === k) || { name: k, color: '#888' };
        pairsEl.innerHTML = pairs.map(k => {
          const a = aByKey(k);
          return '<button class="pair' + (k === defA ? ' sug' : '') + '" data-a="' + k + '">' +
            '<i style="background:' + a.color + '"></i>' + esc(a.name) +
            (k === defA ? '<span class="def">default</span>' : '') + '</button>';
        }).join('');
        pairsEl.querySelectorAll('.pair').forEach(pb =>
          pb.addEventListener('click', () => { tsPreviewAccent = pb.dataset.a; tsApplyPreview(); }));
      }
      tsRefreshSheetAccents();
    }));
  const pick = k => { tsPreviewAccent = k; tsApplyPreview(); };
  document.querySelectorAll('#tsPairs .pair').forEach(b =>
    b.addEventListener('click', () => pick(b.dataset.a)));
  document.querySelectorAll('#tsSwatches .sw').forEach(b =>
    b.addEventListener('click', () => pick(b.dataset.a)));
  // v535 (audit #8): the standing sheet rule — swipe-down-to-dismiss
  // via wireSheetDrag + overlay history, like every other sheet.
  // Dismissal reverts the preview, exactly like the scrim tap; the
  // history back gesture lands on the same path via the token's
  // domCloser.
  if (typeof overlayOpened === 'function') tsToken = overlayOpened('theme-sheet', tsRevert);
  const tsSheetEl = document.querySelector('#tsSheetWrap .tsheet');
  if (tsSheetEl && typeof wireSheetDrag === 'function') wireSheetDrag(tsSheetEl, tsRevert);
}
function tsCloseSheet() {
  if (tsToken != null) {
    const t = tsToken; tsToken = null;
    if (typeof overlayClosed === 'function') overlayClosed(t);
  }
  const w = document.getElementById('tsSheetWrap');
  if (w) w.remove();
}
function tsConfirm() {
  const themeKey = tsPreviewTheme, accentKey = tsPreviewAccent;
  tsCloseSheet();
  tsSnapshot = null; tsPreviewTheme = null; tsPreviewAccent = null;
  try {
    localStorage.setItem('theme', themeKey);
    if (accentKey) localStorage.setItem('accent', accentKey);
    else localStorage.removeItem('accent');
  } catch (e) {}
  applyTheme();
  renderSettings();
  toast('Theme: ' + ((THEMES.find(t => t.key === themeKey) || {}).name || themeKey));
}
function tsRevert() {
  tsCloseSheet();
  tsSnapshot = null; tsPreviewTheme = null; tsPreviewAccent = null;
  applyTheme();
  renderSettings();
}
/* v590: every route that used to open the Profile view (the menu's
 * Profile entry, the deferred handle claim, the retired 'profile'
 * view) lands here instead: Settings, with the Account group — which
 * always starts open — holding the identity form. The flag asks the
 * next renderSettings to scroll the form into view, once. */
let settingsAccountFocus = false;
function openSettingsAccount() {
  settingsAccountFocus = true;
  go('settings');
}

/* S1 (settings review): slim sync-status line for the Settings header --
   answers "is my library safe?" -- reuses the last-sync timestamp from 090-sync. */
function syncStatusLine() {
  try {
    const n = (typeof library !== 'undefined' && library) ? library.length : 0;
    const booksTxt = n + (n === 1 ? ' book' : ' books') + ' safe';
    if (typeof cloudConfigured === 'function' && !cloudConfigured()) {
      return '<span class="sync-dot off">\u25cb</span> Offline \u2014 changes will sync later';
    }
    if (typeof cloudUser === 'undefined' || !cloudUser) {
      return '<span class="sync-dot off">\u25cb</span> Not signed in \u2014 library lives on this device';
    }
    if (typeof cloudSyncing !== 'undefined' && cloudSyncing) {
      return '<span class="sync-dot syncing">\u25cf</span> Syncing\u2026';
    }
    const last = (typeof cloudLastSync !== 'undefined' && cloudLastSync) ? cloudLastSync : 0;
    return '<span class="sync-dot ok">\u25cf</span> Up to date \u00b7 ' + booksTxt;
  } catch (e) { return ''; }
}
function renderSettings() {

  /* ---- Account ---- */
  const prof = loadProfile();
  const profName = ((prof.firstName || '') + ' ' + (prof.lastName || '')).trim();
  const htmlLogin =
    '<p class="note">Sign in to keep your library safe and synced across devices.</p>' +
    '<p class="note" id="ac-status">Checking…</p>' +
    '<div id="ac-signedout">' +
    // v590: real labels for the sign-in fields (they were placeholder-
    // only — a screen reader announced nothing). Visually hidden; the
    // placeholders stay as the visible hint.
    '<div class="search-row"><label class="sr-only" for="ac-email">Email</label><input id="ac-email" type="email" class="text-input" placeholder="Email" autocomplete="email">' +
    '<label class="sr-only" for="ac-pass">Password</label><input id="ac-pass" type="password" class="text-input" placeholder="Password" autocomplete="current-password"></div>' +
    '<div class="search-row"><button class="btn" id="ac-signin">Sign in</button>' +
    '<button class="btn ghost" id="ac-signup">Create account</button></div>' +
    (window.isSecureContext
      ? '<button class="btn ghost block" id="ac-google" style="margin-top:8px">Sign in with Google</button>'
      : '<p class="note">Google sign-in needs localhost or HTTPS — on this connection, use email &amp; password.</p>') +
    '</div>' +
    '<div id="ac-signedin" style="display:none">' +
    '<div class="pf-row">' + avatarHTML(prof, 'st-avatar-card') +
    '<div><div class="st-pname" id="ac-card-name">' + (profName ? esc(profName) : 'Your profile') + '</div>' +
    '<div class="note" id="ac-card-email" style="margin:0"></div></div></div>' +
    '<div class="search-row" style="margin-top:8px"><button class="btn ghost" id="ac-sync">' + icon('cloud') + ' Sync now</button>' +
    '<button class="btn ghost" id="ac-logout">Sign out</button></div>' +
    '<p class="note" id="ac-last"></p></div>';

  // v590 (Variant B): the identity form IS the Account group's second
  // block — the old "Profile & avatar" shortcut row (avatar + @handle
  // line + Edit profile button) is gone because the form it pointed at
  // now lives right here (js/105's accountFormHTML). The gift cluster
  // (js/243's giftClusterHTML: See claims + grants + claims + views
  // log) follows it contiguously; the Circle & privacy panel closes
  // the group (assembled in the groups array below).
  const htmlAccountForm = (signedIn() && typeof accountFormHTML === 'function') ? accountFormHTML() : '';
  const htmlGiftCluster = (signedIn() && typeof giftClusterHTML === 'function') ? giftClusterHTML('st', false) : '';

  /* ---- Library ---- */
  const htmlBackup =
    '<p class="note">Your library lives on this device. Export it regularly — future you will be grateful.</p>' +
    '<button class="btn block" id="bk-export">' + icon('download') + ' Export library (' + library.length + ' books)</button>' +
    '<button class="btn ghost block" id="bk-import">' + icon('upload') + ' Import from file</button>' +
    '<input type="file" id="bk-file" accept="application/json" style="display:none">' +
    // v590: the "merges by ISBN" helper sentence lives ONCE — in the
    // import hub's own copy (js/132); the duplicate that stood here is
    // removed (census F-copy: three import doors, one repeated line).
    importHubHTML('im');

  // v536 (audit #9): manual door for the library metadata check
  // (js/134 runMetadataCheck — the tested check that had no entry
  // point). Missing details fill in on their own; differences wait for
  // per-field review behind the book modal's badge, as built in v476.
  const htmlMetaCheck =
    '<p class="note">Compare every book with an ISBN against the metadata source. ' +
    'Missing details (page counts, covers, years) fill in automatically; where your copy ' +
    'differs, the book gets a quiet badge in its detail view so you can pick which value wins.</p>' +
    '<button class="btn ghost block" id="bk-metacheck">' + icon('search') + ' Check library metadata</button>' +
    '<div id="bk-metacheck-out" aria-live="polite"></div>';

  const htmlData =
    '<p class="note">Delete everything on this device and in your cloud account. <b>This cannot be undone</b> — export a backup first.</p>' +
    '<button class="btn danger block" id="bk-wipe">Delete everything</button>' +
    '<p class="note" style="margin-top:14px"><b>Missing books?</b> The app keeps a separate shelf per sign-in. ' +
    'If your library looks empty after signing out, your books are usually still on this device under your account.</p>' +
    '<button class="btn ghost block" id="bk-find">' + icon('search') + ' Find my library</button>' +
    '<div id="bk-found"></div>';

  /* ---- Appearance (v416: visual theme gallery replaces the blind dropdown) ---- */
  const htmlTheme =
    '<div class="field"><label>Theme</label>' +
    '<p class="note" style="margin:2px 0 0">Tap a theme to preview it live.</p></div>' +
    // v423: pin the gallery to the ACTUAL theme (not the preview) so cards don't
    // get wonky when the preview changes the document's CSS variables.
    '<div data-theme="' + esc(getTheme()) + '">' + themeGalleryHTML() + '</div>' +
    '<div class="field" style="margin-top:14px"><label>Accent</label><div class="swatches" id="th-accent">' +
    ACCENTS.map(a =>
      '<button class="sw' + (effectiveAccent() === a.key ? ' active' : '') + '" data-a="' + a.key + '"' +
      ' style="--sw:' + a.color + '" title="' + a.name + '" aria-label="' + a.name + ' accent"></button>').join('') +
    '</div><p class="note">The gallery suggests pairings per theme — this stays for free choice.</p></div>' +
    '<div class="field"><label>Book pull-out animation</label><div class="seg" id="th-anim" style="grid-template-columns:1fr 1fr">' +
    ['on', 'off'].map(t =>
      '<button data-t="' + t + '" class="' + (animEnabled() === (t === 'on') ? 'active' : '') + '" aria-pressed="' + (animEnabled() === (t === 'on') ? 'true' : 'false') + '">' +
      (t === 'on' ? icon('sparkles') + ' On' : icon('pause') + ' Off') + '</button>').join('') +
    '</div></div>';

  const htmlDisplay =
    '<p class="note">Wishlist books show “Where to buy” links for stores in your region.</p>' +
    '<div class="field"><label>Storefront region</label><div class="seg" id="th-region" style="grid-template-columns:1fr 1fr">' +
    ['auto'].concat(STORE_REGION_KEYS).map(r =>
      '<button data-r="' + r + '" class="' + (storeRegionSetting() === r ? 'active' : '') + '" aria-pressed="' + (storeRegionSetting() === r ? 'true' : 'false') + '">' +
      (r === 'auto' ? icon('globe') + ' Auto' : STORE_REGIONS[r].label) + '</button>').join('') +
    '</div></div>' +
    // v432: visible shelf view preference (2D/3D) — the v407 one-way trap proved
    // invisible preferences are a design smell.
    '<div class="field"><label>Shelf view</label><div class="seg" id="th-shelfview" style="grid-template-columns:1fr 1fr">' +
    ['3d', '2d'].map(m =>
      '<button data-m="' + m + '" class="' + (shelfViewMode() === m ? 'active' : '') + '" aria-pressed="' + (shelfViewMode() === m ? 'true' : 'false') + '">' +
      (m === '3d' ? icon('cube') + ' 3D' : icon('shelf') + ' 2D') + '</button>').join('') +
    '</div></div>' +
    '<p class="note">Switch between the 3D bookshelf and the classic 2D view.</p>' +
    // v571: book dressing — accents follow the currently-reading book's
    // cover (spec: docs/book-dressing-spec.md). Default ON; the stored
    // value is only ever 'off', in the v537 prefs section (roams).
    '<label class="checkline" style="margin-top:10px"><input type="checkbox" id="st-bookdress" ' +
    ((function () { try { return typeof bookDressingEnabled !== 'function' || bookDressingEnabled(); } catch (e) { return true; } })() ? 'checked' : '') + '> ' +
    'Dress for my current book<span class="chk-hint">The app&rsquo;s accent colours follow the cover of the book you&rsquo;re reading. Backgrounds and text never change. Synced across your devices.</span></label>' +
    '<div class="field"><button class="btn ghost" id="th-shelfreset">Reset shelf layout</button></div>' +
    '<p class="note">Clears decoration placements and the shelf view preference — a safety net for shelf weirdness.</p>' +
    // v476: moved from the removed Metadata section — it's a capture
    // preference, not metadata enrichment.
    '<label class="checkline" style="margin-top:10px"><input type="checkbox" id="st-yolo" ' +
    (typeof ecYoloEnabled === 'function' && ecYoloEnabled() ? 'checked' : '') + '> AI crop' +
    '<span class="chk-hint">On-device book detection for tighter cover crops. Turn off if you see odd permission prompts.</span></label>';

  /* ---- Reading ---- */
  // v590: the "Remove today's entry" Show/Hide SETTING is retired — the
  // button is contextual (it exists only on days with an entry to
  // remove), so its gate is hardcoded Show in js/040 and no control
  // renders here. What remains is the reading-preferences block proper
  // (moved out of the Library group, where it never belonged).
  const htmlReadLog =
    // v468: Book Portrait — survey + nudge toggles, warning preferences
    setSub('Book Portrait') +
    '<label class="checkline"><input type="checkbox" id="st-dnasurvey" ' +
    ((function () { try { return localStorage.getItem('cozylibram.dnaSurveyOff') !== '1'; } catch (e) { return true; } })() ? 'checked' : '') + '> ' +
    'Post-read surveys<span class="chk-hint">After finishing a book, a gentle optional survey helps map its portrait for the next reader.</span></label>' +
    '<label class="checkline" style="margin-top:10px"><input type="checkbox" id="st-dnanudges" ' +
    ((function () { try { return localStorage.getItem('cozylibram.dnaNudgesOff') !== '1'; } catch (e) { return true; } })() ? 'checked' : '') + '> ' +
    'Reading nudges<span class="chk-hint">Occasional one-question prompts while reading (max 2 per book). Never for content warnings.</span></label>' +
    '<div class="field" style="margin-top:10px"><label>Content warning preferences</label>' +
    '<button class="btn ghost block" id="st-warnprefs">' + icon('eye') + ' Set warning preferences</button>' +
    '<p class="note">Choose warnings to surface prominently and how much detail you want. Private to your account — syncs across your devices, never shared with anyone.</p></div>' +
    // v535 (audit #7): the trope-source control has been WIRED in
    // Settings since v141 (see the #trope-srcseg handler below), but
    // its segment lived in the Metadata/Hardcover group removed in
    // v476 — anyone who set it before v476 was frozen with no UI. The
    // machinery (js/062) never stopped working; the control lives here
    // now, with the other reading-data preferences.
    ((function () {
      try {
        if (typeof tropeSource !== 'function' || typeof TROPE_SOURCES === 'undefined') return '';
        return '<div class="field" style="margin-top:10px"><label>Trope suggestions</label><div class="seg" id="trope-srcseg" style="grid-template-columns:repeat(4,1fr)">' +
          TROPE_SOURCES.map(t =>
            '<button data-t="' + t + '" class="' + (tropeSource() === t ? 'active' : '') + '" aria-pressed="' + (tropeSource() === t ? 'true' : 'false') + '">' +
            ((typeof TROPE_SRC_LABELS !== 'undefined' && TROPE_SRC_LABELS[t]) || t) + '</button>').join('') +
          '</div></div>' +
          '<p class="note">Where a book&rsquo;s trope tags come from: the story&rsquo;s own keywords, Hardcover&rsquo;s community tags, both, or off entirely.</p>';
      } catch (e) { return ''; }
    })());

  /* ---- Metadata (v476: section hidden — enrichment is automatic now) ---- */
  // htmlHardcover / htmlMetaCheck / htmlPageCounts / htmlCovers removed.
  // The YOLO crop toggle moved to Display (it's a capture preference,
  // not metadata enrichment).

  /* ---- Offline ---- */
  const htmlOffline =
    '<button class="btn ghost block" id="cover-offline">' + icon('download') + ' Cache covers for offline</button>' +
    '<p class="note">Saves every book\'s cover on this device so the library renders fully without internet. ' +
    'Covers are shared canonical copies (one per unique cover, stored once for everyone); this button only saves ' +
    'this device\'s offline copies. Cached covers survive app updates.</p>' +
    '<p class="note" id="cover-cache-usage">Checking cover storage…</p>' +
    '<button class="btn ghost block" id="cover-cache-clear">' + icon('trash') + ' Clear cached covers</button>' +
    '<p class="note">Clears only this device\'s offline copies — the shared canonical covers are untouched.</p>';

  /* ---- Privacy ---- */
  // v346: spoiler protection toggle (default ON)
  const htmlSpoiler =
    '<label class="checkline" style="margin-top:10px"><input type="checkbox" id="st-spoilers" ' +
    (typeof spoilersHidden === 'function' && spoilersHidden() ? 'checked' : '') + '> ' +
    'Hide spoilers <span class="note">(character fates, key moments — tap to reveal)</span></label>';
  // v590: Circle & privacy moved INTO the Account group (it closes the
  // group, under the gift cluster — see the groups array). The
  // read-only "The Hearth sharing" summary and the "Manage sharing"
  // teleport button are CUT: the live panel is right there, and the
  // Hearth overlay remains the Hearth's own door. Hide spoilers moved
  // to Reading (with the shield + warning prefs — the "What you see"
  // trio). Privacy keeps the account-level preferences.
  const htmlPrivacy =
    setSub('Preferences') +
    // v118: usage-analytics opt-out. Default ON for signed-in users; never
    // tracks guests, never collects book content — see docs/ANALYTICS.md.
    '<label class="checkline" style="margin-top:10px"><input type="checkbox" id="st-analytics" ' +
    (analyticsEnabled() ? 'checked' : '') + '> ' + icon('chart') + ' Anonymous usage statistics' +
    '<span class="chk-hint">Helps improve the app. Counts how features are used — never what books you own.</span></label>' +
    '<p class="note" style="margin-top:6px"><a href="#" id="st-analytics-what">What exactly is collected?</a></p>' +
    '<p class="note" id="st-analytics-detail" hidden>Usage data is linked to your account so we can understand which features are used — e.g. “book added from search”, “roulette spun”, “import completed (12 books)”. We never collect book titles, authors, ISBNs, ratings, notes, shelf contents, or private messages as part of product analytics. Events are batched, queued offline, and readable only by the app admin. Diagnostic/error logs never leave your device. Full list: <b>docs/ANALYTICS.md</b> in the repo.</p>';
    // v476: library value is automatic now — no opt-in needed.

  /* ---- About ---- */
  const htmlAbout =
    '<p class="note">Version on this device: <b id="ap-ver">checking…</b></p>' +
    '<div class="search-row"><button class="btn ghost" id="ap-update">Check for updates</button></div>' +
    '<p class="note" id="ap-status"></p>' +
    '<div class="search-row"><a class="btn ghost" href="./downloads/cozylibram.apk" download>Download APK (Android v1.0.7)</a></div>' +
    '<p class="note">Install the Android app directly — no GitHub login needed.</p>' +
    '<details class="set-diag"><summary>Diagnostics</summary>' +
    '<p class="note">Cover grid CSS (this device): <b id="ap-css">checking…</b></p>' +
    '<p class="note">Cover grid CSS (home server): <b id="ap-css-srv">checking…</b></p>' +
    '</details>';

  // v590: start-collapsed rule — the Account group opens, every other
  // group starts closed, on every render. (The persisted per-device
  // open-state is retired; the frozen key stays stored, unread.)
  const openIdx = [0];

  // v590: the Purchase Ledger GROUP leaves Settings — it was one
  // read-only figure wearing a group; the numbers live in Chronicles
  // (js/170's library-value card reads the same estimateBookValue).
  // The Reading group: reading preferences (out of Library) + the
  // "What you see" trio gathered adjacently — the content shield
  // (js/195's shieldSegHTML; its user_state home is unchanged), Hide
  // spoilers (out of Privacy), and the warning-preferences entry
  // (inside htmlReadLog's Book Portrait block above).
  const htmlReading = htmlReadLog + setSub('What you see') +
    (typeof shieldSegHTML === 'function' ? shieldSegHTML('rd') : '') +
    htmlSpoiler;

  const groups = [
    ['user', 'Account', 'Sign in, profile & gifts',
      '<h3 class="set-sub serif" id="ac-subhead">Login</h3>' + htmlLogin +
      (htmlAccountForm ? setSub('Your details') + htmlAccountForm : '') +
      (htmlGiftCluster ? setSub('Gift a Book') + htmlGiftCluster : '') +
      setSub('Circle & privacy') +
      (typeof circlePrivacyIntroHTML === 'function' ? circlePrivacyIntroHTML() : '') +
      '<div id="st-circle-privacy"><div class="skel"></div><div class="skel" style="width:70%"></div></div>'],
    ['covers', 'Library', 'Backups, imports & data',
      setSub('Backup & export') + htmlBackup + setSub('Metadata check') + htmlMetaCheck + setSub('Data management') + htmlData],
    ['reading', 'Reading', 'Surveys, nudges & what you see',
      htmlReading],
    ['sparkles', 'Appearance', 'Theme & display',
      setSub('Theme') + htmlTheme + setSub('Display') + htmlDisplay],
    // v476: Metadata group removed — Hardcover auto-enrich, page-count
    // backfill, and cover download now run automatically on boot (see
    // 095-gate.js). The bulk-action UI is gone; the functions remain for
    // the automatic path. Metadata corrections: blanks auto-fill in the
    // compare sweep (134-verify.js); conflicts get a per-field compare
    // sheet from the quiet badge in the book modal.
    ['download', 'Offline', 'On this device',
      setSub('Cover cache') + htmlOffline],
    ['eyeoff', 'Privacy', 'Sharing',
      htmlPrivacy],
    ['help', 'About', 'Version & diagnostics',
      setSub('App') + htmlAbout],
  ];

  setView(
    '<div class="view-head"><button class="btn ghost sm" id="st-back">← Back</button>' +
    '<h2 class="section serif">Settings</h2></div>' +
    '<p class="sync-line">' + syncStatusLine() + '</p>' +
    groups.map((g, i) => setGroupShell(g[0], g[1], g[2], g[3], i, openIdx)).join('')
  );

  // v590: no open-state persistence anymore (start-collapsed rule).

  // v590: the account form (js/105) wires itself — autosave commit,
  // handle editor, gift address slot.
  if (signedIn() && typeof wireAccountForm === 'function') wireAccountForm(document.getElementById('view'));
  // Arriving via the menu's Profile entry (or the retired 'profile'
  // route): bring the identity form into view, once.
  if (settingsAccountFocus) {
    settingsAccountFocus = false;
    const firstInput = document.getElementById('pf-first');
    if (firstInput && firstInput.scrollIntoView) { try { firstInput.scrollIntoView({ block: 'start' }); } catch (e) {} }
  }

  // Appearance wiring
  document.getElementById('st-back').addEventListener('click', () => {
    // v242: a signed-out visitor (e.g. an invite-link recipient who opened
    // Settings from the menu) goes back to the sign-in gate, not an empty
    // library. Mirrors leaveApp()'s return-to-gate.
    if (signedIn()) go('library');
    else { renderTopbar(); renderGate(); }
  });
  // v416: theme gallery wiring (replaces the old #th-theme dropdown)
  document.querySelectorAll('.tcard').forEach(card =>
    card.addEventListener('click', () => {
      const th = THEMES.find(t => t.key === card.dataset.th);
      if (th) tsOpenSheet(th);
    }));
  document.querySelectorAll('#th-accent .sw').forEach(btn =>
    btn.addEventListener('click', () => {
      localStorage.setItem('accent', btn.dataset.a);
      applyTheme();
      document.querySelectorAll('#th-accent .sw').forEach(x => x.classList.toggle('active', x === btn));
      toast('Accent updated ✨');
    }));
  document.querySelectorAll('#th-anim button').forEach(btn =>
    btn.addEventListener('click', () => {
      try { localStorage.setItem('spicyshelves.animation', btn.dataset.t); } catch (e) {}
      document.querySelectorAll('#th-anim button').forEach(x => { const on = x === btn; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    }));
  document.querySelectorAll('#th-region button').forEach(btn =>
    btn.addEventListener('click', () => {
      try { localStorage.setItem('spicyshelves.storeRegion', btn.dataset.r); } catch (e) {}
      document.querySelectorAll('#th-region button').forEach(x => { const on = x === btn; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      toast('Store region: ' + (btn.dataset.r === 'auto' ? 'auto-detect 🌍' : STORE_REGIONS[btn.dataset.r].label));
    }));

  // v432: shelf view preference toggle
  document.querySelectorAll('#th-shelfview button').forEach(btn =>
    btn.addEventListener('click', () => {
      shelfSetViewMode(btn.dataset.m);
      document.querySelectorAll('#th-shelfview button').forEach(x => { const on = x === btn; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      toast('Shelf view: ' + (btn.dataset.m === '3d' ? '3D 📚' : '2D 📖'));
    }));

  // v432: reset shelf layout — clears decorations and view preference
  document.getElementById('th-shelfreset').addEventListener('click', () => {
    if (!confirm('Reset the shelf? This clears decoration placements and the 2D/3D view preference.')) return;
    try {
      localStorage.removeItem('shelfViewMode');
      // Clear 3D decoration layouts (per-device keys)
      Object.keys(localStorage).filter(k => k.indexOf('shelf3d') === 0 || k.indexOf('shelfDeco') === 0)
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
    toast('Shelf reset — reload to see the default layout.');
  });

  // v536 (audit #9): run the metadata check on demand. Progress rides
  // the check's own callback; the summary names what was filled and
  // where differences wait for review (the book modal's quiet badge).
  document.getElementById('bk-metacheck').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = document.getElementById('bk-metacheck-out');
    btn.disabled = true;
    try {
      const s = await runMetadataCheck((done, total) => {
        if (out) out.innerHTML = '<p class="note">Checking ' + done + ' of ' + total + '…</p>';
      });
      if (out) {
        if (!s.checked) out.innerHTML = '<p class="note">No books with an ISBN to check yet.</p>';
        else {
          const parts = ['Checked ' + s.checked + ' book' + (s.checked === 1 ? '' : 's')];
          if (s.filled) parts.push(s.filled + ' filled in');
          if (s.differ) parts.push(s.differ + ' differ' + (s.differ === 1 ? 's' : '') + ' — open a flagged book to review');
          if (s.notFound) parts.push(s.notFound + ' not found');
          if (!s.filled && !s.differ) parts.push('everything matches');
          out.innerHTML = '<p class="note">' + parts.join(' · ') + '</p>';
        }
      }
    } catch (err) {
      if (out) out.innerHTML = '<p class="note">The check hiccuped — try again in a bit.</p>';
    }
    btn.disabled = false;
  });

  document.getElementById('bk-export').addEventListener('click', async () => {
    const blob = new Blob([JSON.stringify({ app: 'cozy-libram', version: 1, exported: new Date().toISOString(), books: library }, null, 2)],
      { type: 'application/json' });
    // v560: share-first (js/050 shareOrDownloadFile) — on mobile the backup
    // goes straight to a share target; on desktop it downloads as before.
    const how = await shareOrDownloadFile({
      blob: blob,
      filename: 'cozy-libram-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      title: 'Cozy Libram backup',
    });
    if (how === 'downloaded') toast('Backup downloaded 💾');
  });
  document.getElementById('bk-import').addEventListener('click', () =>
    document.getElementById('bk-file').click());
  document.getElementById('bk-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        const books = Array.isArray(data) ? data : data.books;
        if (!Array.isArray(books)) throw new Error('bad file');
        let added = 0, updated = 0, skipped = 0;
        const imported = [];
        books.forEach(b => {
          if (!b || !b.title) { skipped++; return; }
          // v534: keep the exported id. The Up Next queue, the manual
          // shelf order and the roamed state are all keyed by book id,
          // and a re-import must not duplicate the library (or the
          // cloud rows a push would create from fresh ids). Collision
          // rule: an incoming id that already exists overwrites that
          // book in place — restore semantics — and lifts its
          // tombstone, so the next cloud merge can't re-delete it.
          // Only id-less records mint a fresh id.
          const keepId = (typeof b.id === 'string' && b.id) ? b.id : null;
          const nb = migrateBook(Object.assign(normalizeVolume({ volumeInfo: {} }), b, { id: keepId || uid() }));
          const at = library.findIndex(x => x && x.id === nb.id);
          if (at !== -1) {
            library[at] = nb; imported.push(nb); updated++;
          } else if (alreadyHave(nb)) { skipped++; return; }
          else {
            library.push(nb); imported.push(nb); added++;
          }
          // A restored book (either path) lifts its tombstone —
          // otherwise the next cloud merge would re-delete it.
          const ti = tombstones.findIndex(t => t && t.id === nb.id);
          if (ti !== -1) tombstones.splice(ti, 1);
        });
        saveLibrary(); render();
        // Cover-storage closure: enqueue adoption for the imported
        // covers in the background — the import never waits on it.
        if (typeof adoptBookCoverInBackground === 'function') imported.forEach(adoptBookCoverInBackground);
        toast('Imported ' + added + ' books' + (updated ? ' (' + updated + ' restored)' : '') + (skipped ? ' (' + skipped + ' skipped)' : ''));
      } catch (err) { toast('Could not read that file'); }
    };
    r.readAsText(f);
    e.target.value = '';
  });
  // Account wiring
  document.getElementById('ac-signin').addEventListener('click', () => {
    const em = document.getElementById('ac-email').value.trim();
    const pw = document.getElementById('ac-pass').value;
    if (!em || !pw) { toast('Enter email and password'); return; }
    cloudSignIn(em, pw);
  });
  document.getElementById('ac-signup').addEventListener('click', () => {
    const em = document.getElementById('ac-email').value.trim();
    const pw = document.getElementById('ac-pass').value;
    if (!em || !pw) { toast('Enter email and password'); return; }
    if (pw.length < 6) { toast('Password needs at least 6 characters'); return; }
    cloudSignUp(em, pw);
  });
  const ggBtn = document.getElementById('ac-google');
  if (ggBtn) ggBtn.addEventListener('click', cloudGoogle);
  document.getElementById('ac-logout').addEventListener('click', cloudSignOut);
  document.getElementById('ac-sync').addEventListener('click', async () => {
    await cloudFirstSync({ announce: true }); // v144: quiet unless it changed something
  });
  refreshAccountUI();
  // v590: the Edit-profile and Manage-sharing shortcut buttons are gone
  // with the surfaces they pointed at (the form and the panel are both
  // on this page now).
  // v118: analytics opt-out
  // v346: spoiler toggle
  document.getElementById('st-spoilers').addEventListener('change', e => {
    try { setSpoilersHidden(e.target.checked); } catch (err) {}
    toast(e.target.checked ? 'Spoilers hidden' : 'Spoilers visible');
  });
  document.getElementById('st-analytics').addEventListener('change', e => {
    setAnalyticsEnabled(e.target.checked);
    toast(e.target.checked ? 'Anonymous usage statistics on' : 'Anonymous usage statistics off — nothing further will be recorded');
  });
  // v476: library value is automatic — no opt-in toggle needed.
  // v468: Book Portrait toggles + warning preferences
  var dnaSv = document.getElementById('st-dnasurvey');
  if (dnaSv) dnaSv.addEventListener('change', e => {
    try { localStorage.setItem('cozylibram.dnaSurveyOff', e.target.checked ? '0' : '1'); } catch (err) {}
    toast(e.target.checked ? 'Post-read surveys on' : 'Post-read surveys off');
  });
  var dnaNu = document.getElementById('st-dnanudges');
  if (dnaNu) dnaNu.addEventListener('change', e => {
    try { localStorage.setItem('cozylibram.dnaNudgesOff', e.target.checked ? '0' : '1'); } catch (err) {}
    toast(e.target.checked ? 'Reading nudges on' : 'Reading nudges off');
  });
  var wpBtn = document.getElementById('st-warnprefs');
  if (wpBtn) wpBtn.addEventListener('click', function () {
    try { if (typeof openWarningPrefs === 'function') openWarningPrefs(); } catch (e) {}
  });
  var yoloTgl = document.getElementById('st-yolo');
  if (yoloTgl) yoloTgl.addEventListener('change', e => {
    if (typeof ecSetYoloEnabled === 'function') ecSetYoloEnabled(e.target.checked);
    toast(e.target.checked ? 'AI crop on' : 'AI crop off — using edge detection only');
  });
  var dressTgl = document.getElementById('st-bookdress');
  if (dressTgl) dressTgl.addEventListener('change', e => {
    // ON is the default and is encoded by REMOVING the key (the prefs
    // section's full-snapshot semantics: absent = default); OFF stores it.
    try {
      if (e.target.checked) localStorage.removeItem('cozylibram.bookdress');
      else localStorage.setItem('cozylibram.bookdress', 'off');
    } catch (err) {}
    try { if (typeof refreshBookDressing === 'function') refreshBookDressing(); } catch (err) {}
    toast(e.target.checked ? 'Dressing for your current book' : 'Book dressing off — your theme\u2019s accents apply');
  });
  document.getElementById('st-analytics-what').addEventListener('click', e => {
    e.preventDefault();
    const d = document.getElementById('st-analytics-detail');
    if (d) d.hidden = !d.hidden;
  });
  // v522: Circle & privacy panel — live toggles, same controls (and same
  // save path) as the Hearth's Privacy sheet.
  (async () => {
    const box = document.getElementById('st-circle-privacy');
    if (!box) return;
    if (!cloudUser || typeof circlePrivacy !== 'function' || typeof circlePrivacyPanelHTML !== 'function') {
      box.innerHTML = '<p class="note">Sign in to manage what your circle can see.</p>';
      return;
    }
    try {
      const priv = await circlePrivacy();
      // v559: shelves offered for hiding = hideableShelves() (the four
      // statuses + the Wishlist view identity), like the Hearth sheet
      // (js/195). v534: the FULL list — filtering to statuses with
      // books on them trapped the user: a shelf hidden while it had
      // books and later emptied lost its only Settings unhide chip.
      const shelves = hideableShelves();
      box.innerHTML = circlePrivacyPanelHTML(priv, 'st', shelves);
      // v590: wire against the whole view — the gift cluster the wire
      // reveals and fills now lives in the Account group beside the
      // panel, not inside this box.
      wireCirclePrivacyPanel(document.getElementById('view'), priv, 'st');
      // The cluster rendered before the saved state was known; bring
      // its See-claims seg in step with what actually loaded.
      const gcSeg = document.getElementById('st-giftclaims');
      if (gcSeg) gcSeg.querySelectorAll('button').forEach(x => {
        const on = (x.dataset.v === '1') === (priv.giftClaims === true);
        x.classList.toggle('active', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      // v590: the content shield renders in Reading now — wire it here,
      // where the privacy state has just been loaded.
      if (typeof wireShieldSeg === 'function') wireShieldSeg(document.getElementById('view'), 'rd');
      // v526: Blocked readers — my own block list lives under the same
      // panel; renderBlockedReaders (js/195) renders nothing at all
      // when the blocks table isn't there yet.
      if (typeof renderBlockedReaders === 'function') {
        const bwrap = document.createElement('div');
        bwrap.id = 'st-blocked';
        box.appendChild(bwrap);
        renderBlockedReaders(bwrap).catch(() => {});
      }
      // v574: "My margin notes" (js/242) — the author's own notes
      // list, under the same panel; renders nothing when the
      // feature isn't live or the list is empty.
      if (typeof renderMarginaliaMine === 'function') {
        const mwrap = document.createElement('div');
        mwrap.id = 'st-marginalia-mine';
        box.appendChild(mwrap);
        renderMarginaliaMine(mwrap).catch(() => {});
      }
    } catch (e) {
      box.innerHTML = '<p class="note">Couldn\'t load sharing settings.</p>';
    }
  })();

  document.getElementById('bk-wipe').addEventListener('click', async () => {
    // v352: in-app confirms (native confirm blocks renderer)
    const ok1 = await confirmModal('Delete ALL ' + library.length + ' books? Export a backup first!', { okLabel: 'Delete all' });
    if (!ok1) return;
    const ok2 = await confirmModal('Really? This cannot be undone.', { okLabel: 'Yes, delete' });
    if (!ok2) return;
    library.forEach(b => {
      if (!tombstones.some(t => t.id === b.id)) tombstones.push({ id: b.id, at: Date.now() });
    });
    saveTombstones();
    library = []; saveLibrary({ noCloud: true }); render();
    await cloudWipe();
    toast('Shelves cleared');
  });

  // "Find my library" — lists every on-device library partition (one
  // per sign-in plus the offline shelf) with book counts, restores any of
  // them into the open library, and can pull the cloud copy when signed in.
  // (v136; kept as a grace-period safety net after v204 removed the
  // sign-out hand-back with signed-out mode.)
  document.getElementById('bk-find').addEventListener('click', async () => {
    const box = document.getElementById('bk-found');
    box.innerHTML = '<p class="note">Looking on this device…</p>';
    // v517 (#131): partitions now include the IndexedDB slots (async).
    const parts = await libraryPartitions();
    if (!parts.length) {
      box.innerHTML = '<p class="note">No saved libraries found on this device.</p>';
      return;
    }
    box.innerHTML = parts.map((p, i) =>
      '<div class="row-flex" style="align-items:center;gap:10px;margin:8px 0">' +
      '<div style="flex:1;min-width:0"><b>' + esc(partitionLabel(p)) + '</b><br>' +
      '<span class="note">' + p.n + ' book' + (p.n === 1 ? '' : 's') +
      (p.current ? ' · currently open' : '') + '</span></div>' +
      ((!p.current && p.n > 0)
        ? '<button class="btn small" data-restore="' + i + '">Restore</button>' : '') +
      '</div>').join('') +
      ((typeof cloudUser !== 'undefined' && cloudUser && cloudConfigured())
        ? '<button class="btn ghost block" id="bk-cloud-check" style="margin-top:8px">' + icon('cloud') +
          ' Check my cloud library</button><div id="bk-cloud"></div>'
        : '<p class="note">Sign in to also check your cloud library.</p>');
    box.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', async () => {
      const p = parts[Number(btn.dataset.restore)];
      // v352: in-app confirm
      const ok = p && await confirmModal('Restore ' + p.n + ' books from "' + partitionLabel(p) +
        '"? This replaces the ' + library.length + ' books currently open.', { okLabel: 'Restore' });
      if (!ok) return;
      const n = await restorePartition(p.key);
      render();
      toast(n ? 'Restored ' + n + ' books ✓' : 'Nothing to restore');
      document.getElementById('bk-find').click(); // refresh the list
    }));
    const cc = document.getElementById('bk-cloud-check');
    if (cc) cc.addEventListener('click', async () => {
      const cbox = document.getElementById('bk-cloud');
      cbox.innerHTML = '<p class="note">Checking cloud…</p>';
      try {
        const rows = await cloudPullRows();
        if (!rows.length) { cbox.innerHTML = '<p class="note">Cloud library is empty.</p>'; return; }
        cbox.innerHTML = '<p class="note">Cloud has ' + rows.length + ' books.</p>' +
          '<button class="btn small" id="bk-cloud-dl">Download into this library</button>';
        document.getElementById('bk-cloud-dl').addEventListener('click', async () => {
          // v141: downloading is an explicit un-delete (see resurrectCloudBooks).
          // v142: say so honestly if the cloud refused to drop the deletions.
          const res = await resurrectCloudBooks(rows);
          if (res.blocked > 0) {
            toast('Restored ' + res.added + ' ✓ — but ' + res.blocked +
              ' cloud deletions would not clear; tell Luna');
          } else {
            toast(res.added > 0
              ? 'Restored ' + res.added + ' book' + (res.added === 1 ? '' : 's') + ' from cloud ✓'
              : 'Already up to date ✓');
          }
          document.getElementById('bk-find').click();
        });
      } catch (e) { cbox.innerHTML = '<p class="note">Cloud check failed: ' + esc(cloudErrMsg(e)) + '</p>'; }
    });
  });

  // v224 (UX-13): the import hub is shared with the Add screen.
  wireImportHub('im');

  // v476: Metadata section removed — enrichment runs automatically on boot
  // (see 095-gate.js). The bulk-action buttons (hc-test, hc-bulk,
  // hc-autoseg, pc-backfill, meta-verify, cover-bulk) no longer exist in
  // the UI; their handlers are removed. The underlying functions
  // (enrichHardcover, backfillPageCounts, downloadMissingCovers) remain
  // for the automatic path; corrections use the compare sheet (134-verify.js).
  // v109: pre-cache every remote cover through an <img> load so the service
  // worker's image cache picks it up (destination === 'image').
  let coverOfflineBusy = false;
  document.getElementById('cover-offline').addEventListener('click', async () => {
    const btn = document.getElementById('cover-offline');
    if (btn.disabled || coverOfflineBusy) return;
    const targets = library.filter(b => b.cover && /^https?:\/\//i.test(b.cover));
    if (!targets.length) { toast('No remote covers to cache'); return; }
    btn.disabled = true; coverOfflineBusy = true;
    const loadImg = (url) => new Promise(res => {
      const img = new Image();
      img.onload = () => res(true);
      img.onerror = () => res(false);
      setTimeout(() => res(false), 10000);
      img.src = url;
    });
    let okc = 0;
    for (let i = 0; i < targets.length; i++) {
      btn.textContent = 'Caching ' + (i + 1) + '/' + targets.length + '…';
      if (await loadImg(targets[i].cover)) okc++;
    }
    coverOfflineBusy = false; btn.disabled = false;
    btn.innerHTML = icon('download') + ' Cache covers for offline';
    toast('Cached ' + okc + ' of ' + targets.length + ' covers for offline 📴');
  });
  // v216: live cover-storage readout + clear-cached-covers. The clear button
  // only drops this device's offline copies from the 'cozy-libram-covers'
  // cache — the shared canonical copies in the Supabase bucket are untouched.
  async function refreshCoverCacheUsage() {
    const el = document.getElementById('cover-cache-usage');
    if (!el) return;
    try {
      let count = 0;
      try {
        if (typeof caches !== 'undefined' && caches.open) {
          const cc = await caches.open('cozy-libram-covers');
          count = (await cc.keys()).length;
        }
      } catch (e) {}
      let mb = null;
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          if (est && typeof est.usage === 'number') mb = (est.usage / 1048576).toFixed(1);
        }
      } catch (e) {}
      el.textContent = 'On this device: ' + (mb === null ? '?' : mb + ' MB') +
        ' total · ' + count + ' cover' + (count === 1 ? '' : 's') + ' cached';
    } catch (e) {
      el.textContent = 'Cover storage info is unavailable on this device.';
    }
  }
  const clearBtn = document.getElementById('cover-cache-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    try {
      if (typeof caches !== 'undefined' && caches.delete) await caches.delete('cozy-libram-covers');
      toast('🗑️ Cached covers cleared (shared copies untouched)');
    } catch (e) {
      toast('Could not clear the cover cache');
    }
    refreshCoverCacheUsage();
  });
  refreshCoverCacheUsage();
  // v81: trope suggestion source
  document.querySelectorAll('#trope-srcseg button').forEach(btn =>
    btn.addEventListener('click', () => {
      setTropeSource(btn.dataset.t);
      document.querySelectorAll('#trope-srcseg button').forEach(x => { const on = x === btn; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      toast('Trope suggestions: ' + TROPE_SRC_LABELS[btn.dataset.t]);
    }));
  // App version + updates
  runningAppVersion().then(v => {
    const el = document.getElementById('ap-ver');
    if (el) el.textContent = v || 'unknown';
  });
  cachedCssStatus().then(s => {
    const el = document.getElementById('ap-css');
    if (el) el.textContent = s === 'new' ? 'fixed ✓' : (s === 'old' ? 'stale — grid guard active' : 'unknown');
  });
  serverCssStatus().then(s => {
    const el = document.getElementById('ap-css-srv');
    if (el) el.textContent = s === 'new' ? 'fixed ✓' : (s === 'old' ? 'stale — re-extract the zip on the PC' : 'unknown');
  });
  document.getElementById('ap-update').addEventListener('click', () => {
    checkForAppUpdate(document.getElementById('ap-status'));
  });
}
