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
    '<h2 class="section serif">Your shelves at a glance</h2>' +
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + counts.tbr + '</div><div class="l">TBR</div></div>' +
    '<div class="stat"><div class="n">' + counts.reading + '</div><div class="l">Reading</div></div>' +
    '<div class="stat"><div class="n">' + counts.read + '</div><div class="l">Read</div></div>' +
    '<div class="stat"><div class="n">' + (ax0 ? (axTot[ax0].t / axTot[ax0].n).toFixed(1) : '–') + '</div><div class="l">' + (ax0 ? 'Avg ' + axisByKey(ax0).emoji : 'Avg 💥') + '</div></div>' +
    '</div>' +
    '<h2 class="section serif">Appearance</h2>' +
    '<div class="field"><label>Theme</label><div class="seg" id="th-theme" style="grid-template-columns:1fr 1fr">' +
    ['dark', 'light'].map(t =>
      '<button data-t="' + t + '" class="' + (getTheme() === t ? 'active' : '') + '">' +
      (t === 'dark' ? '🌙 Dark' : '☀️ Light') + '</button>').join('') +
    '</div></div>' +
    '<div class="field"><label>Accent</label><div class="swatches" id="th-accent">' +
    ACCENTS.map(a =>
      '<button class="sw' + (getAccent() === a.key ? ' active' : '') + '" data-a="' + a.key + '"' +
      ' style="--sw:' + a.color + '" title="' + a.name + '" aria-label="' + a.name + ' accent"></button>').join('') +
    '</div></div>' +
    '<div class="field"><label>Book pull-out animation</label><div class="seg" id="th-anim" style="grid-template-columns:1fr 1fr">' +
    ['on', 'off'].map(t =>
      '<button data-t="' + t + '" class="' + (animEnabled() === (t === 'on') ? 'active' : '') + '">' +
      (t === 'on' ? '✨ On' : '🚫 Off') + '</button>').join('') +
    '</div></div>' +
    '<h2 class="section serif" style="margin-top:26px">Shopping</h2>' +
    '<p class="note">Wishlist books show “Where to buy” links for stores in your region.</p>' +
    '<div class="field"><label>Storefront region</label><div class="seg" id="th-region" style="grid-template-columns:1fr 1fr">' +
    ['auto'].concat(STORE_REGION_KEYS).map(r =>
      '<button data-r="' + r + '" class="' + (storeRegionSetting() === r ? 'active' : '') + '">' +
      (r === 'auto' ? '🌍 Auto' : STORE_REGIONS[r].label) + '</button>').join('') +
    '</div></div>' +
    '<h2 class="section serif">Backup</h2>' +
    '<p class="note">Your library lives on this device. Export it regularly — future you will be grateful.</p>' +
    '<button class="btn block" id="bk-export">⬇ Export library (' + library.length + ' books)</button>' +
    '<button class="btn ghost block" id="bk-import">⬆ Import from file</button>' +
    '<input type="file" id="bk-file" accept="application/json" style="display:none">' +
    '<p class="note">Import merges by ISBN — books you already have are skipped.</p>' +
    '<h2 class="section serif" style="margin-top:26px">Page counts</h2>' +
    '<p class="note">Look up total pages by ISBN for books that are missing them — ' +
    'checked via Google Books first, then Open Library.</p>' +
    '<button class="btn ghost block" id="pc-backfill">📄 Fill missing page counts</button>' +
    '<p class="note" id="pc-backfill-note"></p>' +
    '<h2 class="section serif" style="margin-top:26px">Hardcover</h2>' +
    '<p class="note">Connect your free Hardcover account to auto-pull series info, content warnings, and moods. ' +
    'On your home network the server can share the token automatically (see server-config.json) — ' +
    'otherwise paste it here; it stays on this device. Get one at hardcover.app → Account settings → API.</p>' +
    (hcServerToken() && !hcManualToken() ? '<p class="note">🏠 Using the token from your home server — no need to enter anything.</p>' : '') +
    '<div class="search-row"><input id="hc-token" type="password" class="text-input" ' +
    'placeholder="hc_pat_…" value="' + esc(hcManualToken()) + '">' +
    '<button class="btn" id="hc-save">Save</button></div>' +
    '<div class="search-row"><button class="btn ghost" id="hc-test">Test connection</button>' +
    '<button class="btn ghost" id="hc-bulk">Enrich all books</button></div>' +
    '<p class="note" id="hc-status">' + hcStatusText() + '</p>' +
    '<h2 class="section serif" style="margin-top:26px">Google Books</h2>' +
    '<p class="note">Google Books lookups share one anonymous quota that can run out. ' +
    'Add your own free API key for a personal quota of 1,000 requests/day: Google Cloud Console → ' +
    'enable the "Books API" → Credentials → Create an API key (restrict it to the Books API). ' +
    'The key stays on this device; on your home network the server can share it automatically ' +
    '(see server-config.json).</p>' +
    (gbServerKey() && !gbManualKey() ? '<p class="note">🏠 Using the key from your home server — no need to enter anything.</p>' : '') +
    '<div class="search-row"><input id="gb-key" type="password" class="text-input" ' +
    'placeholder="AIza…" value="' + esc(gbManualKey()) + '">' +
    '<button class="btn" id="gb-save">Save</button></div>' +
    '<p class="note" id="gb-status">' + gbKeyStatusText() + '</p>' +
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
    '<div class="search-row"><button class="btn ghost" id="ac-sync">☁️ Sync now</button>' +
    '<button class="btn ghost" id="ac-logout">Sign out</button></div>' +
    '<p class="note" id="ac-last"></p>' +
    '</div>' +
    '<p class="note">Supabase project — from your Supabase dashboard → Project Settings → API:</p>' +
    (cloudServerCfg().url ? '<p class="note">🏠 Using the home server’s Supabase config — no need to enter anything.</p>' : '') +
    '<div class="search-row"><input id="ac-url" class="text-input" placeholder="https://xyzcompany.supabase.co" ' +
    'value="' + esc(cloudManualCfg().url) + '" autocapitalize="off" spellcheck="false"></div>' +
    '<div class="search-row"><input id="ac-key" type="password" class="text-input" placeholder="anon public key" ' +
    'value="' + esc(cloudManualCfg().key) + '" autocapitalize="off" spellcheck="false">' +
    '<button class="btn" id="ac-save">Save</button></div>' +
    '<button class="btn danger block" id="bk-wipe" style="margin-top:26px">Delete everything</button>'
  );

  // Appearance wiring
  document.querySelectorAll('#th-theme button').forEach(btn =>
    btn.addEventListener('click', () => {
      localStorage.setItem('theme', btn.dataset.t);
      applyTheme();
      document.querySelectorAll('#th-theme button').forEach(x => x.classList.toggle('active', x === btn));
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
      document.querySelectorAll('#th-anim button').forEach(x => x.classList.toggle('active', x === btn));
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
  document.getElementById('ac-save').addEventListener('click', () => {
    const u = document.getElementById('ac-url').value.trim();
    const k = document.getElementById('ac-key').value.trim();
    if (u) localStorage.setItem('sb_url', u); else localStorage.removeItem('sb_url');
    if (k) localStorage.setItem('sb_key', k); else localStorage.removeItem('sb_key');
    sbClient = null; sbClientCfg = ''; cloudUser = null; // force reconnect
    toast(u && k ? 'Supabase config saved' : 'Supabase config cleared');
    initCloud();
  });
  refreshAccountUI();

  document.getElementById('bk-wipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL ' + library.length + ' books? Export a backup first!')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    library = []; bookSnapshots.clear(); saveLibrary({ noCloud: true }); render();
    await cloudWipe();
    toast('Shelves cleared');
  });

  // Google Books key wiring
  document.getElementById('gb-save').addEventListener('click', () => {
    const v = document.getElementById('gb-key').value.trim();
    if (v) localStorage.setItem('gbooks_key', v);
    else localStorage.removeItem('gbooks_key');
    const st = document.getElementById('gb-status'); if (st) st.textContent = gbKeyStatusText();
    toast(v ? 'Google Books key saved' : 'Google Books key removed');
  });

  // Hardcover wiring
  const hcStatus = () => document.getElementById('hc-status');
  document.getElementById('hc-save').addEventListener('click', () => {
    const v = document.getElementById('hc-token').value.trim();
    if (v) localStorage.setItem('hc_token', v);
    else localStorage.removeItem('hc_token');
    const st = hcStatus(); if (st) st.textContent = hcStatusText();
    toast(v ? 'Hardcover token saved' : 'Hardcover token removed');
  });
  document.getElementById('pc-backfill').addEventListener('click', () => backfillPageCounts());
  document.getElementById('hc-test').addEventListener('click', async () => {
    const st = hcStatus(); if (!st) return;
    if (!hcToken()) { st.textContent = 'Save a token first.'; return; }
    st.textContent = 'Testing…';
    try {
      const data = await hcGraphQL('query { search(query: "Dune", query_type: "Book", per_page: 1) { results } }');
      const hits = hcHits(data);
      st.textContent = hits.length ? 'Connected ✓ — found "' + hits[0].document.title + '"' : 'Connected, but got no results.';
    } catch (e) { st.textContent = 'Failed: ' + e.message; }
  });
  document.getElementById('hc-bulk').addEventListener('click', async () => {
    const btn = document.getElementById('hc-bulk');
    if (!hcToken()) { toast('Save a Hardcover token first'); return; }
    if (btn.disabled) return;
    btn.disabled = true;
    const targets = library.filter(b => !b.hcEnriched);
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      const st = hcStatus(); if (st) st.textContent = 'Enriching ' + (i + 1) + '/' + targets.length + '… (' + ok + ' matched)';
      try { if (await enrichHardcover(targets[i])) ok++; } catch (e) { /* skip */ }
      await new Promise(r => setTimeout(r, 1100)); // stay under the 60 req/min limit
    }
    saveLibrary(); render();
    const st2 = hcStatus(); if (st2) st2.textContent = 'Done — ' + ok + ' of ' + targets.length + ' books enriched ✨';
    toast('Hardcover enrichment complete ✨');
  });
}

