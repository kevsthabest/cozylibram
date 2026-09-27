'use strict';

/* ---------------- backup view ---------------- */
function renderSettings() {
  const counts = { tbr: 0, reading: 0, read: 0, dnf: 0 };
  const axTot = {};
  library.forEach(b => {
    if (counts[b.status] != null) counts[b.status]++;
    if (b.status !== 'read') return;
    RATING_AXES.forEach(a => {
      const v = (b.ratings || {})[a.key] || 0;
      if (v > 0) {
        axTot[a.key] = axTot[a.key] || { t: 0, n: 0 };
        axTot[a.key].t += v; axTot[a.key].n++;
      }
    });
  });
  const ax0 = Object.keys(axTot).sort((x, y) => axTot[y].n - axTot[x].n)[0];

  setView(
    '<div class="view-head"><button class="btn ghost sm" id="st-back">← Back</button>' +
    '<h2 class="section serif">Your shelves at a glance</h2></div>' +
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + counts.tbr + '</div><div class="l">TBR</div></div>' +
    '<div class="stat"><div class="n">' + counts.reading + '</div><div class="l">Reading</div></div>' +
    '<div class="stat"><div class="n">' + counts.read + '</div><div class="l">Read</div></div>' +
    '<div class="stat"><div class="n">' + (ax0 ? (axTot[ax0].t / axTot[ax0].n).toFixed(1) : '–') + '</div><div class="l">' + (ax0 ? 'Avg ' + icon(axisByKey(ax0).icon || 'pepper') : 'Avg 💥') + '</div></div>' +
    '</div>' +
    '<h2 class="section serif">Appearance</h2>' +
    '<div class="field"><label>Theme</label><select id="th-theme" class="text-input">' +
    THEMES.map(th =>
      '<option value="' + th.key + '"' + (getTheme() === th.key ? ' selected' : '') + '>' +
      th.name + ' · ' + covenNameFor(th.key) + '</option>').join('') +
    '</select><p class="note">Each theme gives your social circle its own name.</p></div>' +
    '<div class="field"><label>Accent</label><div class="swatches" id="th-accent">' +
    ACCENTS.map(a =>
      '<button class="sw' + (getAccent() === a.key ? ' active' : '') + '" data-a="' + a.key + '"' +
      ' style="--sw:' + a.color + '" title="' + a.name + '" aria-label="' + a.name + ' accent"></button>').join('') +
    '</div></div>' +
    '<div class="field"><label>Book pull-out animation</label><div class="seg" id="th-anim" style="grid-template-columns:1fr 1fr">' +
    ['on', 'off'].map(t =>
      '<button data-t="' + t + '" class="' + (animEnabled() === (t === 'on') ? 'active' : '') + '">' +
      (t === 'on' ? icon('sparkles') + ' On' : icon('dnf') + ' Off') + '</button>').join('') +
    '</div></div>' +
    '<h2 class="section serif" style="margin-top:26px">Shopping</h2>' +
    '<p class="note">Wishlist books show “Where to buy” links for stores in your region.</p>' +
    '<div class="field"><label>Storefront region</label><div class="seg" id="th-region" style="grid-template-columns:1fr 1fr">' +
    ['auto'].concat(STORE_REGION_KEYS).map(r =>
      '<button data-r="' + r + '" class="' + (storeRegionSetting() === r ? 'active' : '') + '">' +
      (r === 'auto' ? icon('globe') + ' Auto' : STORE_REGIONS[r].label) + '</button>').join('') +
    '</div></div>' +
    '<h2 class="section serif">Backup</h2>' +
    '<p class="note">Your library lives on this device. Export it regularly — future you will be grateful.</p>' +
    '<button class="btn block" id="bk-export">' + icon('download') + ' Export library (' + library.length + ' books)</button>' +
    '<button class="btn ghost block" id="bk-import">' + icon('upload') + ' Import from file</button>' +
    '<input type="file" id="bk-file" accept="application/json" style="display:none">' +
    '<p class="note">Import merges by ISBN — books you already have are skipped.</p>' +
    '<h3 class="serif" style="margin-top:18px">Import from other apps</h3>' +
    '<p class="note">One front door for every backup: Goodreads, StoryGraph, Hardcover, Bookmory, a list of ISBNs… pick the export file and the app figures out the rest.</p>' +
    '<input type="file" id="im-file" accept=".csv,.txt,.json,.bookmory" style="display:none">' +
    '<button class="btn ghost block" id="im-pick">' + icon('download') + ' Choose an export file</button>' +
    '<div id="im-result"></div>' +
    '<h2 class="section serif" style="margin-top:26px">Page counts</h2>' +
    '<p class="note">Look up total pages by ISBN for books that are missing them — ' +
    'checked via Google Books first, then Open Library.</p>' +
    '<button class="btn ghost block" id="pc-backfill">' + icon('doc') + ' Fill missing page counts</button>' +
    '<p class="note" id="pc-backfill-note"></p>' +
    '<h2 class="section serif" style="margin-top:26px">Reading log</h2>' +
    '<div class="field"><label>“Remove today’s entry” button</label><div class="seg" id="th-rmentry" style="grid-template-columns:1fr 1fr">' +
    ['off', 'on'].map(t =>
      '<button data-t="' + t + '" class="' + (logRemoveEnabled() === (t === 'on') ? 'active' : '') + '">' +
      (t === 'on' ? icon('eye') + ' Show' : icon('eyeoff') + ' Hide') + '</button>').join('') +
    '</div></div>' +
    '<p class="note">When shown, a book’s detail sheet gets a “Remove today’s entry” button on days with logged pages — handy for cleaning up mistaken entries.</p>' +
    '<h2 class="section serif" style="margin-top:26px">Metadata check</h2>' +
    '<p class="note">Compare every book with an ISBN against Open Library and Google Books — ' +
    'flags wrong titles, authors, page counts, publish years, and missing covers. ' +
    'You review each difference and apply the fixes you want; nothing changes on its own.</p>' +
    '<button class="btn ghost block" id="meta-verify">' + icon('search') + ' Check metadata</button>' +
    '<p class="note" id="meta-verify-note">' +
    library.filter(b => cleanISBN(b.isbn)).length + ' of ' + library.length +
    ' books have ISBNs to check.</p>' +
    '<h2 class="section serif" style="margin-top:26px">Covers</h2>' +
    '<p class="note">Fetch covers for every book that doesn\'t have one yet — same sources as the cover picker ' +
    '(Google Books, Open Library, Apple Books, Hardcover). Each candidate is checked to make sure it actually loads before it\'s saved.</p>' +
    '<button class="btn ghost block" id="cover-bulk">' + icon('download') + ' Download missing covers</button>' +
    '<p class="note" id="cover-bulk-note">' +
    library.filter(b => !b.cover).length + ' of ' + library.length +
    ' books are missing covers.</p>' +
    '<h2 class="section serif" style="margin-top:26px">Hardcover</h2>' +
    '<p class="note">Connect your free Hardcover account to auto-pull series info, content warnings, moods, and trope tags.</p>' +
    '<div class="search-row"><button class="btn ghost" id="hc-test">Test connection</button>' +
    '<button class="btn ghost" id="hc-bulk">Enrich all books</button></div>' +
    '<div class="field"><label>Background auto-enrich</label><div class="seg" id="hc-autoseg" style="grid-template-columns:1fr 1fr">' +
    ['off', 'on'].map(t =>
      '<button data-t="' + t + '" class="' + (hcAutoEnabled() === (t === 'on') ? 'active' : '') + '">' +
      (t === 'on' ? icon('sparkles') + ' On' : icon('pause') + ' Off') + '</button>').join('') +
    '</div></div>' +
    '<p class="note">When on, unenriched books are quietly enriched from Hardcover a few seconds after the app opens — no need to tap “Enrich all books”.</p>' +
    '<div class="field"><label>Trope suggestions</label><div class="seg" id="trope-srcseg" style="grid-template-columns:repeat(4,1fr)">' +
    TROPE_SOURCES.map(t =>
      '<button data-t="' + t + '" class="' + (tropeSource() === t ? 'active' : '') + '">' +
      TROPE_SRC_LABELS[t] + '</button>').join('') +
    '</div></div>' +
    '<p class="note">Where automatic trope suggestions come from in the book editor: scan the blurb for trope keywords (offline), pull community tags from Hardcover, or both. Suggestions never overwrite the tropes already saved on a book.</p>' +
    '<h2 class="section serif" style="margin-top:26px">Account & cloud sync</h2>' +
    '<p class="note">Sign in to keep your library safe in your own cloud database and synced across devices. ' +
    'The app works fine without it — everything stays on this device.</p>' +
    '<p class="note" id="ac-status">Checking…</p>' +
    '<div id="ac-signedout">' +
    '<div class="search-row"><input id="ac-email" type="email" class="text-input" placeholder="Email" autocomplete="email">' +
    '<input id="ac-pass" type="password" class="text-input" placeholder="Password" autocomplete="current-password"></div>' +
    '<div class="search-row"><button class="btn" id="ac-signin">Sign in</button>' +
    '<button class="btn ghost" id="ac-signup">Create account</button></div>' +
    (window.isSecureContext
      ? '<button class="btn ghost block" id="ac-google" style="margin-top:8px">Sign in with Google</button>'
      : '<p class="note">Google sign-in needs localhost or HTTPS — on this connection, use email &amp; password.</p>') +
    '</div>' +
    '<div id="ac-signedin" style="display:none">' +
    '<div class="search-row"><button class="btn ghost" id="ac-sync">' + icon('cloud') + ' Sync now</button>' +
    '<button class="btn ghost" id="ac-logout">Sign out</button></div>' +
    '<p class="note" id="ac-last"></p>' +
    '</div>' +
    '<h2 class="section serif" style="margin-top:26px">App</h2>' +
    '<p class="note">Version on this device: <b id="ap-ver">checking…</b></p>' +
    '<p class="note">Cover grid CSS (this device): <b id="ap-css">checking…</b></p>' +
    '<p class="note">Cover grid CSS (home server): <b id="ap-css-srv">checking…</b></p>' +
    '<div class="search-row"><button class="btn ghost" id="ap-update">Check for updates</button></div>' +
    '<p class="note" id="ap-status"></p>' +
    '<button class="btn danger block" id="bk-wipe" style="margin-top:26px">Delete everything</button>'
  );

  // Appearance wiring
  document.getElementById('st-back').addEventListener('click', () => go('library'));
  document.getElementById('th-theme').addEventListener('change', e => {
    localStorage.setItem('theme', e.target.value);
    applyTheme();
  });
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
      document.querySelectorAll('#th-anim button').forEach(x => x.classList.toggle('active', x === btn));
    }));
  document.querySelectorAll('#th-rmentry button').forEach(btn =>
    btn.addEventListener('click', () => {
      try { localStorage.setItem('spicyshelves.logremove', btn.dataset.t); } catch (e) {}
      document.querySelectorAll('#th-rmentry button').forEach(x => x.classList.toggle('active', x === btn));
      toast(btn.dataset.t === 'on' ? '“Remove today’s entry” visible 👁️' : '“Remove today’s entry” hidden 🙈');
    }));
  document.querySelectorAll('#th-region button').forEach(btn =>
    btn.addEventListener('click', () => {
      try { localStorage.setItem('spicyshelves.storeRegion', btn.dataset.r); } catch (e) {}
      document.querySelectorAll('#th-region button').forEach(x => x.classList.toggle('active', x === btn));
      toast('Store region: ' + (btn.dataset.r === 'auto' ? 'auto-detect 🌍' : STORE_REGIONS[btn.dataset.r].label));
    }));

  document.getElementById('bk-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'spicy-shelves', version: 1, exported: new Date().toISOString(), books: library }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spicy-shelves-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup downloaded 💾');
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
        let added = 0, skipped = 0;
        books.forEach(b => {
          if (!b || !b.title) { skipped++; return; }
          const nb = Object.assign(normalizeVolume({ volumeInfo: {} }), b, { id: uid() });
          migrateBook(nb);
          if (alreadyHave(nb)) { skipped++; return; }
          library.push(nb); added++;
        });
        saveLibrary(); render();
        toast('Imported ' + added + ' books' + (skipped ? ' (' + skipped + ' skipped)' : ''));
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
    toast('Syncing…'); await cloudFirstSync();
  });
  refreshAccountUI();

  document.getElementById('bk-wipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL ' + library.length + ' books? Export a backup first!')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    library.forEach(b => {
      if (!tombstones.some(t => t.id === b.id)) tombstones.push({ id: b.id, at: Date.now() });
    });
    saveTombstones();
    library = []; bookSnapshots.clear(); saveLibrary({ noCloud: true }); render();
    await cloudWipe();
    toast('Shelves cleared');
  });

  document.getElementById('im-pick').addEventListener('click', () =>
    document.getElementById('im-file').click());
  document.getElementById('im-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleImportFile(f);
    e.target.value = '';
  });

  // Hardcover wiring
  document.getElementById('pc-backfill').addEventListener('click', () => backfillPageCounts());
  document.getElementById('meta-verify').addEventListener('click', () => runMetadataCheck());
  document.getElementById('hc-test').addEventListener('click', async () => {
    if (!hcReady()) { toast('No Hardcover key on this server'); return; }
    toast('Testing Hardcover…');
    try {
      const data = await hcGraphQL('query { search(query: "Dune", query_type: "Book", per_page: 1) { results } }');
      const hits = hcHits(data);
      toast(hits.length ? 'Connected ✓ — found "' + hits[0].document.title + '"' : 'Connected, but got no results.');
    } catch (e) { toast('Failed: ' + e.message); }
  });
  document.getElementById('hc-bulk').addEventListener('click', async () => {
    const btn = document.getElementById('hc-bulk');
    if (!hcReady()) { toast('No Hardcover key on this server'); return; }
    if (btn.disabled || hcEnrichBusy) return;
    btn.disabled = true; hcEnrichBusy = true;
    const targets = library.filter(b => !b.hcEnriched);
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      btn.textContent = 'Enriching ' + (i + 1) + '/' + targets.length + '…';
      try { if (await enrichHardcover(targets[i])) ok++; } catch (e) { /* skip */ }
      await new Promise(r => setTimeout(r, 1100)); // stay under the 60 req/min limit
    }
    saveLibrary(); render();
    hcEnrichBusy = false;
    btn.textContent = 'Enrich all books';
    toast('Hardcover enrichment complete ✨');
  });
  document.querySelectorAll('#hc-autoseg button').forEach(btn =>
    btn.addEventListener('click', () => {
      try { localStorage.setItem(HC_AUTO_KEY, btn.dataset.t === 'on' ? '1' : '0'); } catch (e) {}
      document.querySelectorAll('#hc-autoseg button').forEach(x => x.classList.toggle('active', x === btn));
      toast(btn.dataset.t === 'on' ? 'Background auto-enrich on ✨' : 'Background auto-enrich off ⏸️');
    }));
  // v107: bulk cover download
  let coverBulkBusy = false;
  document.getElementById('cover-bulk').addEventListener('click', async () => {
    const btn = document.getElementById('cover-bulk');
    if (btn.disabled || coverBulkBusy) return;
    if (!library.some(b => !b.cover)) { toast('Every book already has a cover ✨'); return; }
    btn.disabled = true; coverBulkBusy = true;
    const res = await downloadMissingCovers((i, n) => { btn.textContent = 'Downloading ' + i + '/' + n + '…'; });
    coverBulkBusy = false; btn.disabled = false;
    btn.innerHTML = icon('download') + ' Download missing covers';
    const left = library.filter(b => !b.cover).length;
    document.getElementById('cover-bulk-note').textContent =
      left + ' of ' + library.length + ' books are missing covers.';
    toast(res.done
      ? 'Downloaded ' + res.done + ' cover' + (res.done === 1 ? '' : 's') + ' ✨'
      : 'No covers found this time');
  });
  // v81: trope suggestion source
  document.querySelectorAll('#trope-srcseg button').forEach(btn =>
    btn.addEventListener('click', () => {
      setTropeSource(btn.dataset.t);
      document.querySelectorAll('#trope-srcseg button').forEach(x => x.classList.toggle('active', x === btn));
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
