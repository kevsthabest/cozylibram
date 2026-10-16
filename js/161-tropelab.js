'use strict';

/* ---------------- Trope Lab (v152) ----------------
   The admin Trope Lab, reunited in one module (architecture
   candidate 6): coverage scan, review + claim queues, provider/model
   picker, all-libraries backfill and proposal review — the render
   path is renderTropeLab(), dispatched from the Observatory shell
   in js/199-admin.js (adminTab === 'tropes'). The Lab's data
   machinery that used to sit in js/157-trope-inference.js (the
   admin book projection tropeAdminBooks* and the provider/model
   override tropeProviderGet/Set + tropeModelList) lives at the
   bottom of this file. Everything else trope-shaped stays where it
   was: inference engine, TropeQueue and TropeStore remain in
   js/157; the taxonomy in js/156. Load order: after js/157 (its
   queue/store are called at runtime) and before js/199 (whose tab
   dispatch calls renderTropeLab at runtime); every cross-file
   reference is a runtime call through the shared global scope —
   this file declares only its own state at eval time. */

/* ---------------- Trope Lab (v152) ----------------
   Admin-only trope operations inside the Observatory: provider/key
   status, taxonomy health, coverage counts, and the paced backfill
   queue (pause/resume, per-book failure retry, re-infer on taxonomy
   bumps). Ordinary users never see this — inference runs only when
   an admin starts it here. */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */

export let tropeLabKeyToId = {}; // book_key -> library id, rebuilt on each coverage scan
export let tropeLabLastRows = []; // last book_tropes scan, reused by the all-libraries scan

export function tropeLabBooks() {
  try { return (typeof library !== 'undefined' ? library : []).filter(b => b && !b._deleted); }
  catch (e) { return []; }
}

export function tropeLabResolve(id) {
  return tropeLabBooks().find(b => b.id === id) || null;
}

export async function tropeLabSb() {
  try { return await cloudClient().catch(() => null); }
  catch (e) { return null; }
}

/* Pure-ish: coverage of local books against book_tropes rows.
   Returns { total, tagged, missing:[books], stale:[books] }. A book is
   stale when its rows predate the bundled taxonomy version OR the live
   taxonomy rev (bumped on every Trope Lab approval). `current` defaults
   to the live values; rows without taxonomy_rev count as rev 1
   (the pre-v157 baseline).
   v271: `claimed` is an optional Set of bookKeyFor() keys whose work has a
   non-rejected claim in book_trope_claims. The backfill writes work-keyed
   claims, so a book with claims but no legacy rows still counts as tagged. */
export function tropeLabCoverage(books, rows, current, claimed) {
  current = current || { version: TROPE_TAXONOMY_VERSION, rev: TropeTaxonomy.rev() };
  const byKey = {};
  (rows || []).forEach(r => {
    const e = byKey[r.book_key] || (byKey[r.book_key] = { count: 0, version: 0, rev: 1 });
    e.count++;
    e.version = Math.max(e.version, r.taxonomy_version || 0);
    e.rev = Math.max(e.rev, r.taxonomy_rev || 1);
  });
  const missing = [], stale = [];
  let tagged = 0;
  (books || []).forEach(b => {
    const key = bookKeyFor(b);
    const e = byKey[key];
    if (!e) {
      if (claimed && claimed.has(key)) tagged++;
      else missing.push(b);
    }
    else if (e.version < current.version || e.rev < current.rev) stale.push(b);
    else tagged++;
  });
  return { total: (books || []).length, tagged, missing, stale };
}

/* v271: bookKeyFor() keys whose work holds a non-rejected claim in
   book_trope_claims. Maps work -> ISBNs (editions) and work -> title/author
   norm (works) so books match the same way bookKeyFor keys them.
   Returns a Set, or null when the tables can't be read (caller falls back
   to legacy-only coverage). */
export async function tropeLabClaimedKeys(sb) {
  try {
    const { data: claimRows, error: cErr } = await sb.from('book_trope_claims')
      .select('work_id').neq('status', 'rejected').limit(20000);
    if (cErr) throw cErr;
    const workIds = [...new Set((claimRows || []).map(r => r && r.work_id).filter(Boolean))];
    if (!workIds.length) return new Set();
    const out = new Set();
    const digits = s => String(s || '').replace(/[^0-9X]/gi, '');
    const to13 = s => {
      const d = digits(s);
      if (d.length === 13) return d;
      try { return (typeof isbn13of === 'function') ? (isbn13of(d) || d) : d; }
      catch (e) { return d; }
    };
    try {
      const { data: edRows } = await sb.from('editions')
        .select('isbn, work_id').in('work_id', workIds).limit(20000);
      (edRows || []).forEach(r => {
        const d = digits(r && r.isbn);
        if (!d) return;
        out.add('isbn:' + d);
        const d13 = to13(d);
        if (d13 !== d) out.add('isbn:' + d13);
      });
    } catch (e) { /* editions unreadable — title/author matching still works */ }
    try {
      const { data: wRows } = await sb.from('works')
        .select('id, title_norm, author_norm').in('id', workIds).limit(20000);
      (wRows || []).forEach(w => {
        if (w && w.title_norm) out.add('t:' + w.title_norm + ':' + (w.author_norm || ''));
      });
    } catch (e) { /* works unreadable — ISBN matching still works */ }
    return out;
  } catch (e) {
    return null;
  }
}

export function tropeLabWireQueue() {
  // v153: shared app-wide wiring (resolver, upsert, DB reads); Trope Lab
  // only adds its progress callback on top.
  ensureTropeQueueWired();
  TropeQueue.configure({
    onEvent: () => {
      if (adminTab === 'tropes') tropeLabProgressHTML();
    },
  });
}

/* Refresh only the progress region (called on every queue event). */
export function tropeLabProgressHTML() {
  const el = document.getElementById('tropelab-progress');
  if (!el) return;
  const s = TropeQueue.snapshot();
  const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
  const failedKeys = Object.keys(s.failedDetail || {});
  const failedRows = failedKeys.slice(0, 50).map(k => {
    const t = tropeLabReviewTitle(k); // v276: works-catalog fallback + honest label
    return '<tr><td>' + esc(t.title) + '</td><td class="note">' +
      esc(s.failedDetail[k]) + '</td></tr>';
  }).join('');
  el.innerHTML =
    '<div class="ob-card"><h3 class="serif">Backfill progress</h3>' +
    '<div class="ob-progress"><div class="ob-progress-fill" style="width:' + pct + '%"></div></div>' +
    '<p class="note">' + s.done + ' of ' + s.total + ' done · ' + s.pending + ' pending · ' +
    failedKeys.length + ' failed' +
    (s.running && !s.paused ? ' · <b>running</b>' : s.paused ? ' · paused' : '') +
    (s.fatalError ? ' · <span style="color:var(--danger,#c00)">' + esc(s.fatalError) + '</span>' : '') +
    '</p>' +
    '<div class="ob-ranges">' +
    (s.running && !s.paused
      ? '<button class="btn sm" id="tl-pause">Pause</button>'
      : '<button class="btn sm" id="tl-resume"' + (s.pending ? '' : ' disabled') + '>Resume</button>') +
    '<button class="btn sm ghost" id="tl-retry"' + (failedKeys.length ? '' : ' disabled') + '>Retry failed (' + failedKeys.length + ')</button>' +
    '<button class="btn sm ghost" id="tl-clear">Clear queue</button>' +
    '</div>' +
    (failedKeys.length
      ? '<div class="ob-scroll"><table class="ob-table"><thead><tr><th>Book</th><th>Error</th></tr></thead>' +
        '<tbody>' + failedRows + '</tbody></table></div>' +
        (failedKeys.length > 50 ? '<p class="note">Showing 50 of ' + failedKeys.length + ' failures.</p>' : '')
      : '') +
    '</div>';
  const pause = document.getElementById('tl-pause');
  if (pause) pause.addEventListener('click', () => { TropeQueue.pause(); });
  const resume = document.getElementById('tl-resume');
  if (resume) resume.addEventListener('click', () => { TropeQueue.start(); tropeLabProgressHTML(); });
  const retry = document.getElementById('tl-retry');
  if (retry) retry.addEventListener('click', () => {
    /* v159: local books retry by library id; all-libraries jobs are keyed
       by book_key and resolve through the admin projection. */
    const ids = failedKeys.map(k => tropeLabKeyToId[k] || k).filter(Boolean);
    TropeQueue.clearFailed();
    if (ids.length) { TropeQueue.enqueue(ids); TropeQueue.start(); }
    tropeLabProgressHTML();
  });
  const clear = document.getElementById('tl-clear');
  if (clear) clear.addEventListener('click', () => { TropeQueue.reset(); tropeLabProgressHTML(); });
}

/* ---------------- Trope review queue (v166) ----------------
   Approve inferred tropes without opening each book. Lists every book
   with inferred rows in book_tropes, reusing the book modal's chip +
   ▲▼ vote UI (TropeVotes) — an upvote here is exactly the "approval"
   User used to do one book at a time. "Approve all" upvotes every
   inferred trope for the book in one tap. Unreviewed books sort first
   so the list reads as a work queue. */

export let tropeLabReviewShown = 15; // pagination: how many books are rendered
export const TROPE_LAB_REVIEW_PAGE = 15;

/* Pure: group book_tropes rows into per-book review entries.
   rows: [{book_key, trope_id, confidence, source}].
   byId: trope_id -> {id, name}; rows with unknown ids are dropped.
   Returns [{ bookKey, tropes: [{id, name, confidence, source}] }] with
   tropes sorted by confidence desc. */
export function tropeLabReviewEntries(rows, byId) {
  const byKey = {};
  (rows || []).forEach(r => {
    if (!r || !r.book_key || !r.trope_id) return;
    const t = byId ? byId(r.trope_id) : null;
    if (!t) return;
    const e = byKey[r.book_key] || (byKey[r.book_key] = { bookKey: r.book_key, tropes: [] });
    if (e.tropes.some(x => x.id === t.id)) return;
    e.tropes.push({ id: t.id, name: t.name,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
      source: r.source || 'llm' });
  });
  return Object.keys(byKey).map(k => {
    const e = byKey[k];
    e.tropes.sort((a, b) => b.confidence - a.confidence);
    return e;
  });
}

/* Pure: aggregate trope_votes rows into the {tropeId:{up,down,mine}}
   shape dbTropeChipsHTML expects, keyed by book. `uid` marks the
   current user's own vote. */
export function tropeLabReviewVotes(rows, uid) {
  const agg = {};
  (rows || []).forEach(r => {
    if (!r || !r.book_key || !r.trope_id) return;
    const perBook = agg[r.book_key] || (agg[r.book_key] = {});
    const e = perBook[r.trope_id] || (perBook[r.trope_id] = { up: 0, down: 0, mine: 0 });
    if (r.vote === 1) e.up++;
    else if (r.vote === -1) e.down++;
    if (uid && r.user_id === uid) e.mine = r.vote;
  });
  return agg;
}

/* Resolve a book_key to a display title/authors: local library first,
   then the persisted all-libraries admin projection, then the global works
   catalog (v276: a work row outlives library membership by design, so a
   book deleted from every library still resolves to its title/author). */
export let tropeLabWorkTitles = {}; // isbn -> { title, authors }, primed per render

export async function tropeLabPrimeWorkTitles(sb, keys) {
  tropeLabWorkTitles = {};
  try {
    const isbns = [...new Set((keys || [])
      .filter(k => typeof k === 'string' && k.indexOf('isbn:') === 0)
      .map(k => k.slice(5)))];
    if (!isbns.length) return;
    const r = await sb.from('editions').select('isbn, works(title, authors)').in('isbn', isbns);
    if (r.error) throw r.error;
    (r.data || []).forEach(row => {
      const w = row && row.works;
      if (w && row.isbn) tropeLabWorkTitles[row.isbn] =
        { title: w.title || '', authors: (w.authors || []).join(', ') };
    });
  } catch (e) { /* works lookup is best-effort; the honest label below covers misses */ }
}

export function tropeLabIsbnOf(key) {
  return (typeof key === 'string' && key.indexOf('isbn:') === 0) ? key.slice(5) : null;
}

export function tropeLabReviewTitle(key) {
  try {
    const b = tropeLabResolve(tropeLabKeyToId[key]);
    if (b) return { title: b.title || key, authors: (b.authors || []).join(', ') };
    const ab = tropeAdminBookById(key);
    if (ab) return { title: ab.title || key, authors: (ab.authors || []).join(', ') };
    const isbn = tropeLabIsbnOf(key);
    const m = isbn && tropeLabWorkTitles[isbn];
    if (m && m.title) return { title: m.title, authors: m.authors || '' };
  } catch (e) {}
  // Honest label for keys no catalog knows — never the raw key.
  const isbn = tropeLabIsbnOf(key);
  if (isbn) return { title: 'Removed book · ' + isbn, authors: '' };
  return { title: key, authors: '' };
}

export async function tropeLabReviewHTML() {
  const el = document.getElementById('tropelab-review');
  if (!el) return;
  const head = '<div class="ob-card"><h3 class="serif">Review inferred tropes</h3>';
  const sb = await tropeLabSb();
  if (!sb) {
    el.innerHTML = head + '<p class="note">Sign in to review inferred tropes.</p></div>';
    return;
  }
  let rows = [];
  try {
    const r1 = await sb.from('book_tropes')
      .select('book_key, trope_id, confidence, source').limit(20000);
    if (r1.error) throw r1.error;
    rows = r1.data || [];
  } catch (e) {
    el.innerHTML = head + '<p class="note">' + icon('warn') +
      ' Could not load inferred tropes (' + esc((e && e.message) || 'unknown error') + ').</p></div>';
    return;
  }
  const entries = tropeLabReviewEntries(rows, id => TropeTaxonomy.byId(id));
  if (!entries.length) {
    el.innerHTML = head + '<p class="note">No inferred tropes yet — run a backfill above first.</p></div>';
    return;
  }
  let votes = {};
  try {
    const uid = (typeof localUid !== 'undefined' && localUid) || null;
    const r2 = await sb.from('trope_votes')
      .select('book_key, trope_id, vote, user_id')
      .in('book_key', entries.map(e => e.bookKey));
    if (r2.error) throw r2.error;
    votes = tropeLabReviewVotes(r2.data || [], uid);
  } catch (e) { votes = {}; }
  // v276: prime the works-catalog titles so books deleted from every
  // library still resolve (the work row outlives library membership).
  try { await tropeLabPrimeWorkTitles(sb, entries.map(e => e.bookKey)); } catch (e) {}
  entries.forEach(e => {
    const t = tropeLabReviewTitle(e.bookKey);
    e.title = t.title;
    e.authors = t.authors;
    const v = votes[e.bookKey] || {};
    e.reviewed = e.tropes.every(tr => (v[tr.id] || { mine: 0 }).mine !== 0);
  });
  entries.sort((a, b) =>
    ((a.reviewed ? 1 : 0) - (b.reviewed ? 1 : 0)) ||
    String(a.title).localeCompare(String(b.title)));
  const reviewedCount = entries.filter(e => e.reviewed).length;
  const shown = entries.slice(0, tropeLabReviewShown);
  const byKey = {};
  entries.forEach(e => { byKey[e.bookKey] = e; });
  let html = head +
    '<p class="note">' + entries.length + ' books with inferred tropes · ' +
    reviewedCount + ' fully reviewed by you. ▲ approves a trope, ▼ rejects it — ' +
    'the same votes as in each book\u2019s detail sheet. ' +
    '<button class="btn sm ghost" id="tl-review-refresh">↻ Refresh</button></p>';
  shown.forEach(e => {
    const v = votes[e.bookKey] || {};
    html += '<div class="tl-review-book" data-review-book="' + esc(e.bookKey) + '">' +
      '<div class="tl-review-head"><div><b>' + esc(e.title) + '</b>' +
      (e.authors ? ' <span class="note">· ' + esc(e.authors) + '</span>' : '') +
      (e.reviewed ? ' <span class="note">✓ reviewed</span>' : '') +
      '</div>' +
      '<button class="btn sm ghost" data-approve-all' + (e.reviewed ? ' disabled' : '') +
      '>Approve all</button></div>' +
      '<div class="tl-review-chips">' + dbTropeChipsHTML(e.tropes, 'db', v) + '</div>' +
      '</div>';
  });
  if (entries.length > shown.length) {
    html += '<button class="btn sm" id="tl-review-more">Show more (' +
      (entries.length - shown.length) + ' remaining)</button>';
  }
  el.innerHTML = html + '</div>';

  const refresh = document.getElementById('tl-review-refresh');
  if (refresh) refresh.addEventListener('click', () => tropeLabReviewHTML());
  const more = document.getElementById('tl-review-more');
  if (more) more.addEventListener('click', () => {
    tropeLabReviewShown += TROPE_LAB_REVIEW_PAGE;
    tropeLabReviewHTML();
  });
  el.querySelectorAll('[data-review-book]').forEach(row => {
    const key = row.getAttribute('data-review-book');
    row.querySelectorAll('[data-tv]').forEach(btn => btn.addEventListener('click', async () => {
      const tid = btn.getAttribute('data-tid');
      const want = parseInt(btn.getAttribute('data-tv'), 10);
      btn.disabled = true;
      try { await TropeVotes.toggleVote(key, tid, want); } catch (e) {}
      tropeLabReviewHTML(); // re-render: counts, highlights, reviewed state
    }));
    const all = row.querySelector('[data-approve-all]');
    if (all) all.addEventListener('click', async () => {
      const label = all.textContent;
      all.disabled = true;
      all.textContent = 'Approving…';
      try {
        const entry = byKey[key];
        const v = await TropeVotes.getVotes(key);
        for (const tr of (entry ? entry.tropes : [])) {
          const cur = (v[tr.id] || { mine: 0 }).mine;
          if (cur !== 1) await TropeVotes.vote(key, tr.id, 1);
        }
      } catch (e) {}
      all.textContent = label;
      tropeLabReviewHTML();
    });
  });
}

/* ---------------- Claim review card (v206, v208) ----------------
   Corrections for AI claims, work-wide. v208: high-confidence claims
   with quoted evidence auto-publish, so this queue is corrections-only —
   ✓ confirms a candidate work-wide, ✕ rejects any AI claim (rejections
   survive re-inference). Auto-published tags are badged "auto". */

export let tropeLabClaimsShown = 15;
export const TROPE_LAB_CLAIMS_PAGE = 15;
export let tropeLabClaimsModelFilter = ''; // v315: '' = all models

export async function tropeLabClaimsHTML() {
  const el = document.getElementById('tropelab-claims');
  if (!el) return;
  const head = '<div class="ob-card"><h3 class="serif">Review AI tags</h3>';
  let groups = [];
  try {
    groups = await TropeClaims.listCandidates(500);
  } catch (e) { groups = []; }
  if (!groups.length) {
    el.innerHTML = head +
      '<p class="note">No AI tags awaiting review. High-confidence tags with quoted ' +
      'evidence publish automatically — corrections land here.</p></div>';
    return;
  }
  // v315: model/source filter — distinct models across the queue.
  // Lets reviewers isolate one pipeline (e.g. the ebook processor) from
  // in-app inference.
  const models = [];
  groups.forEach(g => g.tropes.forEach(t => {
    if (t.model && models.indexOf(t.model) < 0) models.push(t.model);
  }));
  models.sort();
  const mf = tropeLabClaimsModelFilter;
  const fgroups = mf
    ? groups.map(g => Object.assign({}, g, {
        tropes: g.tropes.filter(t => t.model === mf),
      })).filter(g => g.tropes.length)
    : groups;
  const shown = fgroups.slice(0, tropeLabClaimsShown);
  let html = head + '<p class="note">' + fgroups.length +
    ' works with AI tags · ✓ confirms a candidate work-wide, ✕ rejects it ' +
    '(rejections survive re-inference). ' +
    '<span class="chip dbtrope ai">auto</span> = published automatically on ' +
    'high confidence + quoted evidence. ' +
    '<button class="btn sm ghost" id="tl-claims-refresh">↻ Refresh</button></p>';
  if (models.length > 1) {
    html += '<p class="note"><label>Source model: <select id="tl-claims-model" class="text-input" style="width:auto;display:inline-block">' +
      '<option value="">All models (' + groups.length + ' works)</option>' +
      models.map(m => '<option value="' + esc(m) + '"' +
        (m === mf ? ' selected' : '') + '>' + esc(m) + '</option>').join('') +
      '</select></label></p>';
  }
  shown.forEach(g => {
    html += '<div class="tl-review-book" data-claim-work="' + esc(g.workId) + '">' +
      '<div class="tl-review-head"><div><b>' + esc(g.title) + '</b>' +
      (g.authors ? ' <span class="note">· ' + esc(g.authors) + '</span>' : '') +
      '</div></div><div class="tl-review-chips">';
    g.tropes.forEach(t => {
      html += '<span class="tgvote"><span class="chip dbtrope ai" title="AI ' +
        (t.auto ? 'auto-published' : 'candidate') + ' · ' +
        Math.round(t.confidence * 100) + '% confidence">' +
        (t.auto ? '✓auto ' : '✦ ') + esc(t.name) + '</span>' +
        (t.auto ? '' :
          '<button class="tvbtn" data-claim="confirmed" data-tid="' + esc(t.id) +
          '" aria-label="Confirm ' + esc(t.name) + '">✓</button>') +
        '<button class="tvbtn" data-claim="rejected" data-tid="' + esc(t.id) +
        '" aria-label="Reject ' + esc(t.name) + '">✕</button></span>';
    });
    html += '</div></div>';
  });
  if (fgroups.length > shown.length) {
    html += '<button class="btn sm" id="tl-claims-more">Show more (' +
      (fgroups.length - shown.length) + ' remaining)</button>';
  }
  el.innerHTML = html + '</div>';

  const refresh = document.getElementById('tl-claims-refresh');
  if (refresh) refresh.addEventListener('click', () => tropeLabClaimsHTML());
  const modelSel = document.getElementById('tl-claims-model');
  if (modelSel) modelSel.addEventListener('change', () => {
    tropeLabClaimsModelFilter = modelSel.value;
    tropeLabClaimsShown = TROPE_LAB_CLAIMS_PAGE; // reset pagination on filter change
    tropeLabClaimsHTML();
  });
  const more = document.getElementById('tl-claims-more');
  if (more) more.addEventListener('click', () => {
    tropeLabClaimsShown += TROPE_LAB_CLAIMS_PAGE;
    tropeLabClaimsHTML();
  });
  el.querySelectorAll('[data-claim-work]').forEach(row => {
    const workId = row.getAttribute('data-claim-work');
    row.querySelectorAll('[data-claim]').forEach(btn => btn.addEventListener('click', async () => {
      const status = btn.getAttribute('data-claim');
      const tid = btn.getAttribute('data-tid');
      btn.disabled = true;
      try { await TropeClaims.setStatus(workId, tid, status); }
      catch (e) {
        btn.disabled = false;
        btn.title = 'Failed: ' + ((e && e.message) || 'unknown error');
        return;
      }
      tropeLabClaimsHTML(); // re-render: the decided claim leaves the queue
    }));
  });
}

export async function renderTropeLab() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  tropeLabWireQueue();
  /* v157: pull the live taxonomy first so counts, staleness, and the
     proposal review all see freshly approved tropes. */
  try { await TropeTaxonomy.refresh(); } catch (e) {}
  /* v160: load the shared provider/model override so the status card
     shows the effective provider. */
  try { await tropeProviderGet(); } catch (e) {}

  const info = tropeProviderInfo();
  const configured = tropeInferenceConfigured();
  const liveCount = TropeTaxonomy.list().length;
  const addedCount = liveCount - TROPES.length;
  const statusCard =
    '<div class="ob-card"><h3 class="serif">' + icon('bulb') + ' Trope Lab</h3>' +
    '<div class="ob-grid">' +
    '<div class="ob-stat"><div class="ob-stat-val" id="tl-stat-provider">' + esc(info.provider || '—') + '</div><div class="ob-stat-label">Provider</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val" id="tl-stat-model" style="font-size:15px;word-break:break-all">' + esc(info.model || '—') + '</div><div class="ob-stat-label">Model</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + (configured ? 'Ready' : 'Missing') + '</div><div class="ob-stat-label">API key</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">v' + TROPE_TAXONOMY_VERSION + ' · ' + liveCount + '</div><div class="ob-stat-label">Taxonomy tropes' +
    (addedCount > 0 ? ' (+' + addedCount + ' added)' : '') + '</div></div>' +
    '</div>' +
    (configured
      ? '<p class="note">Inference calls go through the same-origin <code>/api/trope-infer</code> proxy — the key stays server-side.</p>'
      : '<p class="note">' + icon('warn') + ' No trope API key on this server. Add <code>trope_api_key</code> (+ provider/model) to ' +
        '<code>server-config.json</code>, or set <code>TROPE_API_KEY</code> / <code>TROPE_MODEL</code> in the Pages environment.</p>') +
    '</div>';

  body.innerHTML = statusCard + '<div id="tropelab-provider"></div>' +
    '<div id="tropelab-coverage"><p class="note">Scanning library…</p></div>' +
    '<div id="tropelab-alllibs"></div>' +
    '<div id="tropelab-progress"></div>' +
    '<div id="tropelab-review"></div>';

  // Resume an interrupted backfill when Trope Lab opens.
  const snap = TropeQueue.snapshot();
  let resumed = false;
  if (snap.running && !snap.paused && snap.pending > 0 && configured) {
    TropeQueue.start();
    resumed = true;
  }

  let cov, sbError = '', rows = [];
  try {
    const books = tropeLabBooks();
    tropeLabKeyToId = {};
    books.forEach(b => { tropeLabKeyToId[bookKeyFor(b)] = b.id; });
    const sb = await tropeLabSb();
    rows = [];
    if (sb) {
      const { data, error } = await sb.from('book_tropes')
        .select('book_key, taxonomy_version, taxonomy_rev').limit(20000);
      if (error) sbError = error.message;
      else rows = data || [];
    } else {
      sbError = 'not signed in';
    }
    cov = tropeLabCoverage(books, rows, undefined, await tropeLabClaimedKeys(sb));
  } catch (e) {
    sbError = (e && e.message) || 'scan failed';
    cov = { total: 0, tagged: 0, missing: [], stale: [] };
  }
  tropeLabLastRows = rows;

  const covEl = document.getElementById('tropelab-coverage');
  if (!covEl) return;
  covEl.innerHTML =
    '<div class="ob-card"><h3 class="serif">Coverage</h3>' +
    '<div class="ob-grid">' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.tagged + '</div><div class="ob-stat-label">Books tagged</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.missing.length + '</div><div class="ob-stat-label">Missing</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.stale.length + '</div><div class="ob-stat-label">Stale taxonomy</div></div>' +
    '<div class="ob-stat"><div class="ob-stat-val">' + cov.total + '</div><div class="ob-stat-label">Books scanned</div></div>' +
    '</div>' +
    (sbError ? '<p class="note">' + icon('warn') + ' Cloud read failed (' + esc(sbError) + ') — counts may be incomplete. ' +
      'If the trope tables are missing, run <code>supabase/tropes.sql</code> in the Supabase SQL editor.</p>' : '') +
    (resumed ? '<p class="note">Resumed an interrupted backfill.</p>' : '') +
    '<div class="ob-ranges">' +
    '<button class="btn sm" id="tl-backfill"' + (configured && cov.missing.length ? '' : ' disabled') + '>Backfill missing (' + cov.missing.length + ')</button>' +
    '<button class="btn sm ghost" id="tl-restale"' + (configured && cov.stale.length ? '' : ' disabled') + '>Re-infer stale (' + cov.stale.length + ')</button>' +
    '</div>' +
    '<p class="note">One book at a time, ~4s apart — stays under free-tier limits. ' +
    'Failed or empty inference is never cached as “no tropes”; failures stay listed below for retry. ' +
    'Closing this tab pauses nothing — reopen Trope Lab to resume.</p>' +
    '</div>';

  const wire = (id, books, force) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => {
      const n = TropeQueue.enqueue(books.map(b => b.id), { force: !!force });
      if (n) TropeQueue.start();
      tropeLabProgressHTML();
    });
  };
  wire('tl-backfill', cov.missing);
  wire('tl-restale', cov.stale, true); // v208: explicit re-infer bypasses the input-hash cache
  tropeLabProgressHTML();
  tropeLabProviderHTML();
  tropeLabAllLibrariesHTML(configured);
  tropeLabReviewHTML();

  // v155: user-proposal review queue.
  const propCard = document.createElement('div');
  propCard.innerHTML =
    '<div class="ob-card"><h3 class="serif">Trope proposals</h3>' +
    '<p class="note">The Hearth members propose, vote, and you review. Approving writes the canonical row ' +
    'to the shared taxonomy table and optionally tags the originating book — the new trope is live ' +
    'for inference immediately, no file edit needed.</p>' +
    '<div id="trope-proposals"><p class="note">Loading…</p></div></div>';
  body.appendChild(propCard);
  tropeLabProposalsHTML();

  // v206: AI candidate claim moderation (confirm/reject, work-wide).
  const claimsCard = document.createElement('div');
  claimsCard.innerHTML = '<div id="tropelab-claims"><p class="note">Loading…</p></div>';
  body.appendChild(claimsCard);
  tropeLabClaimsHTML();
}

/* v160: in-app provider/model picker. The choice is stored in the shared
   trope_provider_settings row and applies to all devices on their next
   inference run. API keys stay server-side — the proxy holds one key per
   provider (TROPE_KEY_<PROVIDER>) and the client only names the provider. */
export async function tropeLabProviderHTML() {
  const box = document.getElementById('tropelab-provider');
  if (!box || adminTab !== 'tropes') return;
  let cur = { provider: '', model: '' };
  try { cur = await tropeProviderGet(); } catch (e) {}
  const info = tropeProviderInfo();
  const providers = ['', 'openrouter', 'gemini', 'groq', 'ollama', 'custom'];
  const labels = { '': 'Server default (env)', openrouter: 'OpenRouter', gemini: 'Google Gemini', groq: 'Groq', ollama: 'Ollama (local)', custom: 'Custom' };
  box.innerHTML =
    '<div class="ob-card"><h3 class="serif">Inference provider</h3>' +
    '<p class="note" id="tl-provider-current">Currently: <b>' + esc(info.provider || 'server default') + '</b>' +
    (info.model ? ' · <span style="word-break:break-all">' + esc(info.model) + '</span>' : '') +
    (info.overridden ? ' (override)' : ' (server env)') + '</p>' +
    '<div class="ob-ranges">' +
    '<select id="tl-provider-sel" class="text-input" aria-label="Provider">' +
    providers.map(p => '<option value="' + p + '"' + (cur.provider === p ? ' selected' : '') + '>' + labels[p] + '</option>').join('') +
    '</select>' +
    '<input id="tl-provider-model" class="text-input" list="tl-model-list" placeholder="model (e.g. gemini-3.8-flash)" value="' + esc(cur.model) + '" aria-label="Model">' +
    '<datalist id="tl-model-list"></datalist>' +
    '<button class="btn sm" id="tl-provider-save">Save</button>' +
    '</div>' +
    '<p class="note" id="tl-models-note"></p>' +
    '<p class="note">Applies to all devices. Each provider needs its key on the server ' +
    '(Cloudflare env <code>TROPE_KEY_GEMINI</code>, <code>TROPE_KEY_OPENROUTER</code>, …); ' +
    'picking one without a key fails the next run with a clear error. ' +
    'Choose “Server default” with an empty model to go back to the env settings.</p>' +
    '<p class="note" id="tl-provider-msg"></p></div>';
  const sel = document.getElementById('tl-provider-sel');
  const modelInput = document.getElementById('tl-provider-model');
  const list = document.getElementById('tl-model-list');
  const modelsNote = document.getElementById('tl-models-note');
  /* v164: the datalist first shows the hardcoded suggestions (instant,
     offline-safe), then the live model list from /api/trope-models when it
     loads. A failed load keeps the suggestions — the input stays free text,
     so any model name still works. */
  const fillList = async () => {
    const p = sel.value;
    const sugs = (typeof TROPE_PROVIDER_SUGGESTIONS !== 'undefined' &&
      TROPE_PROVIDER_SUGGESTIONS[p]) || [];
    const showSugs = () => {
      list.innerHTML = sugs.map(s => '<option value="' + esc(s) + '">').join('');
    };
    showSugs();
    if (!p || p === 'custom') {
      modelsNote.textContent = p === 'custom'
        ? 'Custom provider — type the exact model name.'
        : 'Server default — the model comes from the server env.';
      return;
    }
    modelsNote.textContent = 'Loading available models…';
    let live = null;
    try { live = await tropeModelList(p); } catch (e) { live = null; }
    if (p !== sel.value) return; // provider changed while loading
    if (live && live.length) {
      list.innerHTML = live.map(m =>
        '<option value="' + esc(m.id) + '"' +
        (m.name !== m.id ? ' label="' + esc(m.name) + '"' : '') + '>').join('');
      modelsNote.textContent = live.length + ' models available from ' + p +
        ' — pick one or type your own.';
    } else {
      showSugs();
      modelsNote.textContent = 'Could not load the live model list — showing ' +
        'suggestions; you can still type any model name.';
    }
  };
  sel.addEventListener('change', fillList);
  fillList();
  const save = document.getElementById('tl-provider-save');
  save.addEventListener('click', async () => {
    const msg = document.getElementById('tl-provider-msg');
    const p = sel.value, m = modelInput.value.trim();
    if (p && !m) { msg.textContent = 'Pick a model for ' + p + ' (or choose Server default).'; return; }
    if (m && !/^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,119}$/.test(m)) {
      msg.textContent = 'That model name looks invalid.';
      return;
    }
    save.disabled = true;
    try {
      await tropeProviderSet(p, m);
      const now = tropeProviderInfo();
      document.getElementById('tl-provider-current').innerHTML =
        'Currently: <b>' + esc(now.provider || 'server default') + '</b>' +
        (now.model ? ' · <span style="word-break:break-all">' + esc(now.model) + '</span>' : '') +
        (now.overridden ? ' (override)' : ' (server env)');
      const sp = document.getElementById('tl-stat-provider');
      if (sp) sp.textContent = now.provider || '—';
      const sm = document.getElementById('tl-stat-model');
      if (sm) sm.textContent = now.model || '—';
      msg.textContent = 'Saved — all devices use this on their next inference run.';
    } catch (e) {
      msg.textContent = 'Save failed: ' + ((e && e.message) || e);
    }
    save.disabled = false;
  });
}

/* v159: backfill every user's books, not just this device's library.
   Two-step on purpose: the scan is a paginated admin read of the shared
   books table (needs the v159 "admins read all books" policy), and only
   then are the missing/stale ones enqueued. Tags land in the shared
   book_tropes table, so one backfill covers everyone. Jobs are keyed by
   book_key and resolve through the persisted admin projection. */
export function tropeLabAllLibrariesHTML(configured) {
  const box = document.getElementById('tropelab-alllibs');
  if (!box || adminTab !== 'tropes') return;
  box.innerHTML =
    '<div class="ob-card"><h3 class="serif">All libraries</h3>' +
    '<p class="note">Backfill tropes for <b>every</b> user\u2019s books, not just this device\u2019s library. ' +
    'Tags are shared, so one backfill covers everyone. Needs the v159 database rule ' +
    '(re-run <code>supabase/tropes.sql</code>).</p>' +
    '<div class="ob-ranges"><button class="btn sm" id="tl-alllibs-scan"' +
    (configured ? '' : ' disabled') + '>Scan all libraries</button></div>' +
    '<div id="tl-alllibs-result"></div></div>';
  const btn = document.getElementById('tl-alllibs-scan');
  if (btn) btn.addEventListener('click', tropeLabAllLibrariesScan);
}

export async function tropeLabAllLibrariesScan() {
  const out = document.getElementById('tl-alllibs-result');
  const btn = document.getElementById('tl-alllibs-scan');
  if (!out) return;
  if (btn) btn.disabled = true;
  try {
    const sb = await tropeLabSb();
    if (!sb) throw new Error('not signed in');
    /* Paginated admin read; dedupe by book_key (richest record wins).
       Only bibliographic fields are selected — never the full data blob
       (which can hold shelves, ratings, notes). */
    const seen = new Map();
    let users = 0;
    const userIds = new Set();
    const PAGE = 1000;
    let from = 0, done = false;
    out.innerHTML = '<p class="note">Reading all libraries…</p>';
    while (!done) {
      const { data, error } = await sb.from('books')
        .select('user_id, isbn, data->title, data->authors, data->categories, data->description')
        .range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = data || [];
      rows.forEach(r => {
        if (r && r.user_id) userIds.add(r.user_id);
        const book = {
          title: r.title || '',
          authors: r.authors || [],
          categories: r.categories || [],
          isbn: r.isbn || '',
          description: String(r.description || '').slice(0, 2000),
        };
        if (!book.title) return;
        const key = bookKeyFor(book);
        const prev = seen.get(key);
        if (!prev || book.description.length > (prev.book.description || '').length) {
          seen.set(key, { key, book });
        }
      });
      users = userIds.size;
      done = rows.length < PAGE;
      from += PAGE;
      out.innerHTML = '<p class="note">Reading all libraries… ' + seen.size +
        ' unique books so far.</p>';
    }
    const entries = [...seen.values()];
    let rows = tropeLabLastRows || [];
    if (!rows.length) {
      const r2 = await sb.from('book_tropes')
        .select('book_key, taxonomy_version, taxonomy_rev').limit(20000);
      if (r2.error) throw r2.error;
      rows = r2.data || [];
      tropeLabLastRows = rows;
    }
    const cov = tropeLabCoverage(entries.map(e => e.book), rows, undefined,
      await tropeLabClaimedKeys(sb));
    const keyOf = b => bookKeyFor(b);
    const missingKeys = cov.missing.map(keyOf);
    const staleKeys = cov.stale.map(keyOf);
    out.innerHTML =
      '<div class="ob-grid">' +
      '<div class="ob-stat"><div class="ob-stat-val">' + entries.length + '</div><div class="ob-stat-label">Unique books (' + users + ' users)</div></div>' +
      '<div class="ob-stat"><div class="ob-stat-val">' + cov.tagged + '</div><div class="ob-stat-label">Tagged</div></div>' +
      '<div class="ob-stat"><div class="ob-stat-val">' + missingKeys.length + '</div><div class="ob-stat-label">Missing</div></div>' +
      '<div class="ob-stat"><div class="ob-stat-val">' + staleKeys.length + '</div><div class="ob-stat-label">Stale taxonomy</div></div>' +
      '</div>' +
      '<div class="ob-ranges">' +
      '<button class="btn sm" id="tl-alllibs-backfill"' + (missingKeys.length ? '' : ' disabled') +
      '>Backfill missing (' + missingKeys.length + ')</button>' +
      '<button class="btn sm ghost" id="tl-alllibs-restale"' + (staleKeys.length ? '' : ' disabled') +
      '>Re-infer stale (' + staleKeys.length + ')</button>' +
      '</div>' +
      '<p class="note">One book at a time, ~4s apart. Progress and failures appear in Backfill progress above; ' +
      'closing this tab pauses nothing — reopen Trope Lab to resume.</p>';
    const startAll = (keys, force) => {
      /* Persist the projection BEFORE enqueueing — the queue resolves
         through it, including after a reload. */
      try { tropeAdminBooksSave(entries); } catch (e) {}
      const n = TropeQueue.enqueue(keys, { force: !!force });
      if (n) TropeQueue.start();
      tropeLabProgressHTML();
    };
    const bb = document.getElementById('tl-alllibs-backfill');
    if (bb) bb.addEventListener('click', () => startAll(missingKeys));
    const rs = document.getElementById('tl-alllibs-restale');
    // v208: explicit re-infer bypasses the input-hash cache
    if (rs) rs.addEventListener('click', () => startAll(staleKeys, true));
  } catch (e) {
    const msg = (e && e.message) || 'scan failed';
    out.innerHTML = '<p class="note">' + icon('warn') + ' Scan failed (' + esc(msg) + '). ' +
      'If books are unreadable, re-run <code>supabase/tropes.sql</code> for the v159 admin read policy.</p>';
    if (btn) btn.disabled = false;
  }
}


/* v155: admin review queue for user-proposed tropes. */
export async function tropeLabProposalsHTML() {
  const box = document.getElementById('trope-proposals');
  if (!box || adminTab !== 'tropes') return;
  let list = [];
  try {
    list = await TropeProposals.listPending();
  } catch (e) {
    box.innerHTML = '<p class="note">Couldn’t load proposals: ' + esc((e && e.message) || e) + '</p>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<p class="note">No pending proposals.</p>';
    return;
  }
  box.innerHTML = list.map(p => {
    const net = p.votes.up - p.votes.down;
    return '<div class="circle-row" style="margin-bottom:8px"><div class="circle-meta">' +
      '<b>' + esc(p.name) + '</b>' + (p.mine ? ' <span class="note-inline">· yours</span>' : '') +
      '<p class="note" style="margin:4px 0">' + esc(p.description) + '</p>' +
      '<p class="note">' + p.genres.map(g => esc(tropeGenreLabel(g))).join(' · ') +
      ' · votes <b>' + (net > 0 ? '+' : '') + net + '</b> (' + p.votes.up + '▲ ' + p.votes.down + '▼)' +
      (p.book_key ? ' · has an originating book' : '') + '</p>' +
      '<div class="hidden" id="tpexp-' + p.id + '" style="margin-top:8px"></div>' +
      '</div><div class="circle-actions" style="flex-direction:column;align-items:stretch;gap:6px">' +
      '<button class="btn sm" data-papprove="' + p.id + '">Approve</button>' +
      '<button class="btn ghost sm" data-preject="' + p.id + '">Reject</button>' +
      '<select data-pdup="' + p.id + '" class="text-input" style="font-size:12px;padding:6px" aria-label="Mark as duplicate of…">' +
      '<option value="">Duplicate of…</option>' +
      TropeTaxonomy.list().map(t => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('') +
      '</select>' +
      '</div></div>';
  }).join('');

  box.querySelectorAll('[data-papprove]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.papprove;
    btn.disabled = true;
    try {
      const { slug, proposal } = await TropeProposals.approve(id, { tagBook: true });
      const exp = document.getElementById('tpexp-' + id);
      exp.classList.remove('hidden');
      exp.innerHTML = '<p class="note"><b>Approved as <code>' + esc(slug) + '</code> — live now.</b>' +
        (proposal.book_key ? ' Originating book tagged.' : '') +
        ' The taxonomy rev bumped, so tagged books are marked stale and the next backfill can pick up the new trope.</p>';
      const row = btn.closest('.circle-row');
      const acts = row.querySelector('.circle-actions');
      if (acts) acts.innerHTML = '<span class="note">approved ✓</span>';
    } catch (e) {
      btn.disabled = false;
      toast('Approve failed: ' + ((e && e.message) || e));
    }
  }));

  box.querySelectorAll('[data-preject]').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.preject;
    btn.disabled = true;
    try {
      await TropeProposals.reject(id);
      const row = btn.closest('.circle-row');
      if (row) row.remove();
      if (!box.querySelector('.circle-row')) box.innerHTML = '<p class="note">No pending proposals.</p>';
    } catch (e) {
      btn.disabled = false;
      toast('Reject failed: ' + ((e && e.message) || e));
    }
  }));

  box.querySelectorAll('[data-pdup]').forEach(sel => sel.addEventListener('change', async () => {
    const id = sel.dataset.pdup;
    if (!sel.value) return;
    sel.disabled = true;
    try {
      await TropeProposals.markDuplicate(id, sel.value);
      const row = sel.closest('.circle-row');
      if (row) row.remove();
      if (!box.querySelector('.circle-row')) box.innerHTML = '<p class="note">No pending proposals.</p>';
      toast('Marked as duplicate');
    } catch (e) {
      sel.disabled = false;
      toast('Failed: ' + ((e && e.message) || e));
    }
  }));
}

/* ---------------- Admin all-libraries backfill (v159) ----------------
   Trope Lab (admin-only) can backfill every user's books, not just the
   local library. The admin book list is a minimal projection ({key, book});
   all-libraries jobs are keyed by book_key (stable across users), and the
   queue resolver falls back to the projection when the local library has
   no such id. Cleared together with the queue.
   v202: the projection is no longer persisted to localStorage (it duplicated
   the library). It lives in memory for the scan session and is rebuilt on
   demand from the in-memory library when empty. Consequence: after a reload,
   a resumed backfill can only resolve books in the local library — jobs for
   other users' books are dropped as deleted. Re-run the scan to rebuild the
   full projection. */

export const TROPE_ADMIN_BOOKS_KEY = 'cozylibram.tropeadminbooks.v1'; // v202: legacy key, removed on first load
export let tropeAdminBookCache = null; // null = not built yet
export let tropeAdminLegacyDropped = false;

/* Rebuild the {key, book} projection from the in-memory library. Same
   minimal bibliographic shape the admin scan builds from Supabase rows. */
export function tropeAdminBooksRebuild() {
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  return lib.filter(b => b).map(b => ({
    key: bookKeyFor(b),
    book: {
      title: b.title || '',
      authors: b.authors || [],
      categories: b.categories || [],
      isbn: b.isbn || '',
      description: String(b.description || '').slice(0, 2000),
    },
  }));
}

export function tropeAdminBooksLoad() {
  if (!tropeAdminLegacyDropped) {
    tropeAdminLegacyDropped = true;
    try { localStorage.removeItem(TROPE_ADMIN_BOOKS_KEY); } catch (e) {}
  }
  if (tropeAdminBookCache === null) tropeAdminBookCache = tropeAdminBooksRebuild();
  return tropeAdminBookCache;
}

/* Minimal book projection for inference, looked up by book_key. */
export function tropeAdminBookById(id) {
  if (!id) return null;
  const list = tropeAdminBooksLoad();
  for (const b of list) if (b && b.key === id) return b.book || null;
  return null;
}

/* Keep the admin projection in memory for the scan session (v202: no
   localStorage persistence). */
export function tropeAdminBooksSave(list) {
  tropeAdminBookCache = Array.isArray(list) ? list : [];
}

export function tropeAdminBooksClear() {
  tropeAdminBookCache = null;
}

/* ---------------- Provider/model override (v160) ----------------
   The admin picks the inference provider + model in Trope Lab; the choice
   lives in the shared trope_provider_settings row and applies to all
   devices. Empty = use the server env defaults (backward compatible).
   Keys stay server-side: the proxy holds one key per provider
   (TROPE_KEY_<PROVIDER>) and the client only names the provider. */

export const TROPE_PROVIDER_SETTINGS_KEY = 'cozylibram.tropeprovider.v1';
export const TROPE_PROVIDER_SUGGESTIONS = {
  openrouter: ['nvidia/nemotron-nano-9b-v2:free', 'qwen/qwen3-32b:free', 'google/gemma-3-27b-it:free'],
  gemini: ['gemini-3.8-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  ollama: ['llama3.1', 'qwen3'],
  custom: [],
};
export let tropeProviderCache = null; // null = not loaded yet
export let tropeModelListCache = {}; // v164: provider -> [{id, name}], session cache

/* v164: live model list for the Trope Lab picker. Asks the same-origin
   /api/trope-models proxy (the key stays server-side) for the provider's
   real, currently-available models. Resolves [{id, name}]; rejects when the
   list can't be loaded, and the caller falls back to the hardcoded
   TROPE_PROVIDER_SUGGESTIONS. */
export async function tropeModelList(provider) {
  provider = String(provider || '').trim().toLowerCase();
  if (!provider) throw new Error('no provider');
  if (tropeModelListCache[provider]) return tropeModelListCache[provider];
  const r = await apiFetch('/api/trope-models?provider=' + encodeURIComponent(provider));
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
  const models = (body && Array.isArray(body.models) ? body.models : [])
    .filter(m => m && m.id)
    .map(m => ({ id: String(m.id), name: String(m.name || m.id) }));
  tropeModelListCache[provider] = models;
  return models;
}

/* {provider, model} — either may be '' meaning "server default". */
export async function tropeProviderGet() {
  if (tropeProviderCache) return tropeProviderCache;
  let row = null;
  try {
    const sb = await cloudClient().catch(() => null);
    if (sb) {
      const res = await sb.from('trope_provider_settings')
        .select('provider, model').eq('id', 1).maybeSingle();
      if (res && res.data) row = res.data;
    }
  } catch (e) {}
  if (!row) {
    try { row = JSON.parse(localStorage.getItem(TROPE_PROVIDER_SETTINGS_KEY) || 'null'); }
    catch (e) { row = null; }
  }
  tropeProviderCache = {
    provider: String((row && row.provider) || '').trim().toLowerCase(),
    model: String((row && row.model) || '').trim(),
  };
  try { localStorage.setItem(TROPE_PROVIDER_SETTINGS_KEY, JSON.stringify(tropeProviderCache)); }
  catch (e) {}
  return tropeProviderCache;
}

/* Admin-only (RLS enforces). Clears the override when both are empty. */
export async function tropeProviderSet(provider, model) {
  provider = String(provider || '').trim().toLowerCase();
  model = String(model || '').trim();
  const sb = await cloudClient().catch(() => null);
  if (!sb) throw new Error('not signed in');
  const { error } = await sb.from('trope_provider_settings').upsert(
    { id: 1, provider, model, updated_at: new Date().toISOString() },
    { onConflict: 'id' });
  if (error) throw error;
  tropeProviderCache = { provider, model };
  try { localStorage.setItem(TROPE_PROVIDER_SETTINGS_KEY, JSON.stringify(tropeProviderCache)); }
  catch (e) {}
  return tropeProviderCache;
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The classic consumers — js/157-trope-inference.js
   (tropeProviderGet and the shared provider override) and the
   Observatory shell in js/199-admin.js (renderTropeLab dispatch) —
   reach these names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone.
   tropeProviderCache is republished as an accessor property, not a
   value copy: the Lab reassigns it when the provider settings load
   (tropeProviderGet) and on every provider/model save
   (tropeProviderSet), and js/157-trope-inference.js reads it live in
   tropeProviderInfo(). A value copy would freeze the initial null and
   silently disable the provider override; the getter/setter pair
   forwards every read and write to the module binding, so no consumer
   expression changes. */
window.tropeLabKeyToId = tropeLabKeyToId;
window.tropeLabLastRows = tropeLabLastRows;
window.tropeLabBooks = tropeLabBooks;
window.tropeLabResolve = tropeLabResolve;
window.tropeLabSb = tropeLabSb;
window.tropeLabCoverage = tropeLabCoverage;
window.tropeLabClaimedKeys = tropeLabClaimedKeys;
window.tropeLabWireQueue = tropeLabWireQueue;
window.tropeLabProgressHTML = tropeLabProgressHTML;
window.tropeLabReviewShown = tropeLabReviewShown;
window.TROPE_LAB_REVIEW_PAGE = TROPE_LAB_REVIEW_PAGE;
window.tropeLabReviewEntries = tropeLabReviewEntries;
window.tropeLabReviewVotes = tropeLabReviewVotes;
window.tropeLabWorkTitles = tropeLabWorkTitles;
window.tropeLabPrimeWorkTitles = tropeLabPrimeWorkTitles;
window.tropeLabIsbnOf = tropeLabIsbnOf;
window.tropeLabReviewTitle = tropeLabReviewTitle;
window.tropeLabReviewHTML = tropeLabReviewHTML;
window.tropeLabClaimsShown = tropeLabClaimsShown;
window.TROPE_LAB_CLAIMS_PAGE = TROPE_LAB_CLAIMS_PAGE;
window.tropeLabClaimsModelFilter = tropeLabClaimsModelFilter;
window.tropeLabClaimsHTML = tropeLabClaimsHTML;
window.renderTropeLab = renderTropeLab;
window.tropeLabProviderHTML = tropeLabProviderHTML;
window.tropeLabAllLibrariesHTML = tropeLabAllLibrariesHTML;
window.tropeLabAllLibrariesScan = tropeLabAllLibrariesScan;
window.tropeLabProposalsHTML = tropeLabProposalsHTML;
window.TROPE_ADMIN_BOOKS_KEY = TROPE_ADMIN_BOOKS_KEY;
window.tropeAdminBookCache = tropeAdminBookCache;
window.tropeAdminLegacyDropped = tropeAdminLegacyDropped;
window.tropeAdminBooksRebuild = tropeAdminBooksRebuild;
window.tropeAdminBooksLoad = tropeAdminBooksLoad;
window.tropeAdminBookById = tropeAdminBookById;
window.tropeAdminBooksSave = tropeAdminBooksSave;
window.tropeAdminBooksClear = tropeAdminBooksClear;
window.TROPE_PROVIDER_SETTINGS_KEY = TROPE_PROVIDER_SETTINGS_KEY;
window.TROPE_PROVIDER_SUGGESTIONS = TROPE_PROVIDER_SUGGESTIONS;
Object.defineProperty(window, 'tropeProviderCache', { get: () => tropeProviderCache, set: (v) => { tropeProviderCache = v; }, enumerable: true, configurable: true });
window.tropeModelListCache = tropeModelListCache;
window.tropeModelList = tropeModelList;
window.tropeProviderGet = tropeProviderGet;
window.tropeProviderSet = tropeProviderSet;
