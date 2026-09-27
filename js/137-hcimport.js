'use strict';

/* ---------------- Hardcover library import (v103) ---------------- */
/* Lets a user pull their own Hardcover library into the app using their
   personal API token (hardcover.app → Account settings → API). Statuses,
   ratings, read dates, and ISBNs come along; duplicates are skipped by the
   same ISBN/title dedup as every other import source (importForeignBooks).

   The personal token is stored only in this device's localStorage and is
   forwarded to Hardcover through the existing same-origin /api/hardcover
   proxy — the proxy attaches it to the upstream request and never stores it. */

const HC_USER_TOKEN_KEY = 'spicyshelves.hctoken.v1';

function getHcUserToken() {
  try { return localStorage.getItem(HC_USER_TOKEN_KEY) || ''; }
  catch (e) { return ''; }
}
function setHcUserToken(t) {
  try {
    if (t) localStorage.setItem(HC_USER_TOKEN_KEY, t);
    else localStorage.removeItem(HC_USER_TOKEN_KEY);
  } catch (e) {}
}

/* Hardcover reading statuses → our shelves. 4 (Paused) lands on Currently
   Reading — it was started, just parked. 6 (Ignored) is skipped entirely. */
const HC_STATUS_MAP = { 1: 'tbr', 2: 'reading', 3: 'read', 4: 'reading', 5: 'dnf' };

/* GraphQL against Hardcover with the USER's token (not the server token).
   The /api/hardcover proxy uses body.token when present, else the server
   token — so this works even on installs with no server token configured. */
async function hcUserGraphQL(query, token) {
  let r;
  try {
    r = await fetch(HC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, token: token })
    });
  } catch (e) {
    throw new Error('Network error — couldn\'t reach the server. Check your connection and try again.');
  }
  if (r.status === 503) {
    throw new Error('Hardcover isn\'t configured on this server.');
  }
  if (r.status === 401 || r.status === 403) {
    let detail = '';
    try {
      const dj = await r.json();
      detail = (dj && dj.errors && dj.errors[0] && dj.errors[0].message) || '';
    } catch (e) {}
    if (/depth|complex/i.test(detail)) throw new Error('Hardcover query too deep: ' + detail);
    throw new Error('Hardcover rejected your token (HTTP ' + r.status + '). ' +
      'Tokens expire every Jan 1 — grab a fresh one at hardcover.app → Account settings → API.');
  }
  let d;
  try { d = await r.json(); }
  catch (e) { throw new Error('Hardcover returned an unreadable response (HTTP ' + r.status + ').'); }
  if (d.errors && d.errors.length) throw new Error('Hardcover error: ' + d.errors[0].message);
  if (!d.data) throw new Error('Hardcover returned no data — the token may be invalid or revoked.');
  return d.data;
}

async function hcValidateUserToken(token) {
  const data = await hcUserGraphQL('query { me { username } }', token);
  const me = (data && data.me) || {};
  if (!me.username) throw new Error('That token didn\'t return a Hardcover account — double-check it.');
  return me.username;
}

/* Paginated pull of the user's library. The full query nests fairly deep
   (me → user_books → book → editions/contributions/image), so on a depth
   rejection it retries once with a slim query (no ISBNs, covers, or reads). */
function hcUserBooksQuery(offset, slim) {
  const inner = slim
    ? 'status_id rating date_added book { title pages contributions { author { name } } }'
    : 'status_id rating date_added ' +
      'book { title pages image { url } contributions { author { name } } ' +
      'editions(limit: 2, order_by: {users_count: desc}) { isbn_13 isbn_10 } } ' +
      'edition { isbn_13 isbn_10 pages } ' +
      'user_book_reads(limit: 5, order_by: {finished_at: desc}) { started_at finished_at }';
  return 'query { me { user_books(limit: 100, offset: ' + offset +
    ', order_by: {date_added: desc}) { ' + inner + ' } } }';
}

async function hcFetchUserBooks(graphqlFn, token, onProgress) {
  const run = (typeof graphqlFn === 'function') ? graphqlFn : hcUserGraphQL;
  const all = [];
  let offset = 0, slim = false;
  for (;;) {
    let data;
    try {
      data = await run(hcUserBooksQuery(offset, slim), token);
    } catch (e) {
      if (!slim && /too deep/i.test(e.message)) { slim = true; continue; }
      throw e;
    }
    const me = (data && data.me) || {};
    const page = me.user_books || [];
    all.push(...page);
    if (onProgress) onProgress(all.length);
    if (page.length < 100) break;
    offset += 100;
  }
  return all;
}

/* One Hardcover user_books row → a raw book for importForeignBooks.
   Returns null for rows we skip (Ignored / unknown statuses). */
function hcEntryToRaw(e) {
  const status = HC_STATUS_MAP[e.status_id];
  if (!status) return null;
  const b = e.book || {};
  const authors = (b.contributions || [])
    .map(c => c && c.author && c.author.name)
    .filter(Boolean);
  const ed = e.edition || {};
  const eds = b.editions || [];
  const ed0 = eds[0] || {};
  const isbn = cleanISBN(ed.isbn_13 || ed.isbn_10 || ed0.isbn_13 || ed0.isbn_10 || '');
  const rating = Math.max(0, Math.min(5, Math.round(Number(e.rating) || 0)));
  let dateFinished = null;
  for (const r of (e.user_book_reads || [])) {
    if (r && r.finished_at) { dateFinished = r.finished_at; break; }
  }
  return {
    title: String(b.title || '').trim(),
    authors: authors,
    isbn: isbn,
    cover: (b.image && b.image.url) || '',
    status: status,
    myRating: rating,
    pageCount: ed.pages || b.pages || 0,
    dateAdded: e.date_added || new Date().toISOString(),
    dateFinished: dateFinished,
    hcImported: true,
  };
}

/* ---------------- settings panel ---------------- */

function toggleHcImportPanel() {
  const p = document.getElementById('im-hc-panel');
  if (!p) return;
  if (p.dataset.open === '1') { p.innerHTML = ''; p.dataset.open = ''; return; }
  p.dataset.open = '1';
  renderHcImportPanel();
}

function renderHcImportPanel() {
  const p = document.getElementById('im-hc-panel');
  if (!p) return;
  const token = getHcUserToken();
  if (!token) {
    p.innerHTML =
      '<div class="field" style="margin-top:10px"><label>Your Hardcover API token</label>' +
      '<div class="search-row"><input id="hc-token" type="password" class="text-input" ' +
      'placeholder="Paste token here" autocomplete="off" spellcheck="false">' +
      '<button class="btn" id="hc-connect">Connect</button></div>' +
      '<p class="note">Get it free at hardcover.app → Account settings → API. ' +
      'It stays on this device and is only ever sent to Hardcover itself.</p></div>';
    document.getElementById('hc-connect').addEventListener('click', async () => {
      const t = document.getElementById('hc-token').value.trim();
      if (!t) { toast('Paste your Hardcover token first'); return; }
      const btn = document.getElementById('hc-connect');
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        const username = await hcValidateUserToken(t);
        setHcUserToken(t);
        toast('Connected as @' + username + ' ✓');
        renderHcImportPanel();
      } catch (e) {
        toast('Couldn\'t connect: ' + e.message);
        btn.disabled = false; btn.textContent = 'Connect';
      }
    });
    return;
  }
  p.innerHTML =
    '<div class="field" style="margin-top:10px"><label>Hardcover library</label>' +
    '<p class="note" id="hc-who">Checking account…</p>' +
    '<div class="search-row"><button class="btn" id="hc-import">Import my library</button>' +
    '<button class="btn ghost" id="hc-disconnect">Disconnect</button></div>' +
    '<p class="note" id="hc-progress"></p>' +
    '<p class="note">Statuses, star ratings, read dates, and ISBNs come along. ' +
    'Books already on your shelves are skipped; Want to Read → TBR, Currently Reading → Reading, ' +
    'Read → Read, Did Not Finish → DNF.</p></div>';
  hcValidateUserToken(token).then(
    u => { const el = document.getElementById('hc-who'); if (el) el.textContent = 'Connected as @' + u + ' ✓'; },
    () => { const el = document.getElementById('hc-who'); if (el) el.textContent = 'Token saved, but Hardcover isn\'t accepting it — disconnect and reconnect with a fresh token.'; }
  );
  document.getElementById('hc-disconnect').addEventListener('click', () => {
    setHcUserToken('');
    toast('Hardcover disconnected');
    renderHcImportPanel();
  });
  document.getElementById('hc-import').addEventListener('click', async () => {
    const btn = document.getElementById('hc-import');
    const prog = document.getElementById('hc-progress');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      prog.textContent = 'Reading your Hardcover library…';
      const entries = await hcFetchUserBooks(null, token, n => {
        prog.textContent = 'Reading your Hardcover library… ' + n + ' books so far';
      });
      const raws = entries.map(hcEntryToRaw).filter(Boolean);
      prog.textContent = '';
      if (!raws.length) { toast('No importable books found on your Hardcover account'); }
      else importForeignBooks(raws, 'Hardcover');
    } catch (e) {
      toast('Import failed: ' + e.message);
    }
    btn.disabled = false;
  });
}
