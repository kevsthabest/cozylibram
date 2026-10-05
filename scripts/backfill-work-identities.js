#!/usr/bin/env node
/* Work-identity backfill (v272+).
   Fills works.provider_ids for the ~246 pre-v272 works from keyless public
   sources plus IDs the household library already carries, and reports
   duplicate-work candidates. Additive only: JSONB key-fill, never clobbers
   an existing key, no row deletes, no fuzzy title matching.

   Phase 1 — harvest (pure SQL, no network): fold book-level IDs into their
   works via editions.work_id -> editions.isbn -> books.data->>'isbn':
     books.data->>'hcId'    -> hardcover_id   (numeric, stored as text)
     books.data->>'workKey' -> openlibrary_id (only /^\/works\/OL\d+W$/)

   Phase 2 — provider lookup by ISBN (deterministic, keyless, ~1 req/s):
     Open Library: https://openlibrary.org/isbn/{isbn}.json -> works[0].key
     Inventaire:   https://inventaire.io/api/entities?action=by-uris&uris=isbn:{isbn}&format=json
                   -> edition entity -> claims['wdt:P629'][0] (work URI, wd:Q...)
   A work only receives a key when every ISBN that resolves agrees on one
   value; conflicts are reported, never written.

   Phase 3 — dedupe report (read-only): groups of works sharing title_norm
   with differing author_norm, printed for review. No merges are performed —
   merges are destructive and need Kevin's explicit call.

   Hardcover: NOT queried here — the token lives in server-config.json on
   his home PC, not in this environment. hardcover_id still backfills via
   Phase 1 harvest, and the app's enrichment attaches learned IDs over time
   (js/158-works.js workAttachProviderIds). Google Books is intentionally
   skipped (his 2026-10-04 directive: Google out of backfills).

   Usage:
     node scripts/backfill-work-identities.js              # report only, no writes
     node scripts/backfill-work-identities.js --apply      # write phases 1+2
     node scripts/backfill-work-identities.js --dedupe-report  # phase 3 only
     LIMIT=1 node scripts/backfill-work-identities.js      # probe: first work, no writes
     node scripts/backfill-work-identities.js --selftest   # pure-function checks, no DB/net
   Progress: scripts/work-identities-progress.jsonl (resume skips 'ok'/'skip')
   Env: PACE_MS (default 800), OL_BASE, INV_BASE (overrides, e.g. for tests)
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SB = '/home/hatch/workspace/skills/supabase/bin/sb-query';
const REF = 'dvhimjkrroxuatthiizc';
const APP = '/home/hatch/workspace/booktok';
const APPLY = process.argv.includes('--apply');
const DEDUPE_ONLY = process.argv.includes('--dedupe-report');
const SELFTEST = process.argv.includes('--selftest');
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const PACE_MS = parseInt(process.env.PACE_MS || '800', 10);
const OL_BASE = (process.env.OL_BASE || 'https://openlibrary.org').replace(/\/+$/, '');
const INV_BASE = (process.env.INV_BASE || 'https://inventaire.io').replace(/\/+$/, '');
const UA = 'CozyLibram/work-identity-backfill (private owner-operational script)';
const progressPath = path.join(APP, 'scripts', 'work-identities-progress.jsonl');

const sql = q => JSON.parse(
  execFileSync(SB, [REF, q], { maxBuffer: 256 * 1024 * 1024 }).toString());
const lit = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const sleep = ms => new Promise(r => setTimeout(r, ms));
function logProgress(obj) {
  fs.appendFileSync(progressPath, JSON.stringify(obj) + '\n');
}

/* ---------------- pure helpers (covered by --selftest) ---------------- */

/* Mirrors SQL norm_ident() / js tropeNormIdent: lowercase, strip accents,
   non-alnum -> space, drop leading "the". */
function normIdent(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^the\s+/, '');
}
function isOlWorkKey(k) { return /^\/works\/OL\d+W$/i.test(String(k || '')); }
function isInvWorkUri(u) { return /^(wd|inv):Q\d+$/i.test(String(u || '')); }
function isHardcoverId(v) { return /^\d+$/.test(String(v || '')); }
function isIsbn(s) { return /^[0-9]{10}$|^[0-9]{13}$/.test(String(s || '')); }

/* All agreeing -> the value; zero or conflicting -> null (reported). */
function consensus(vals) {
  const seen = [...new Set((vals || []).filter(v => v != null && v !== ''))];
  return seen.length === 1 ? seen[0] : null;
}

/* Merge provider-id additions into the current JSONB. Returns the merged
   object, or null when nothing would change. Strictly additive: only fills
   keys that are absent — an existing key is never overwritten, even when
   the incoming value differs (that is a conflict for human review). */
function mergeProviderIds(cur, add) {
  cur = (cur && typeof cur === 'object') ? cur : {};
  const out = { ...cur };
  let changed = false;
  for (const k of Object.keys(add || {})) {
    const v = add[k];
    if (v == null || v === '') continue;
    if (out[k] == null || out[k] === '') { out[k] = v; changed = true; }
  }
  return changed ? out : null;
}

/* ---------------- network lookups (keyless, deterministic) ---------------- */

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

/* OL edition by ISBN -> first /works/OL…W key, or null. */
async function olWorkKeyForIsbn(isbn) {
  const d = await fetchJson(`${OL_BASE}/isbn/${isbn}.json`);
  if (!d || !Array.isArray(d.works)) return null;
  for (const w of d.works) {
    if (w && isOlWorkKey(w.key)) return w.key;
  }
  return null;
}

/* Inventaire edition by ISBN -> wdt:P629 work URI (wd:Q…), or null. */
async function invWorkUriForIsbn(isbn) {
  const d = await fetchJson(
    `${INV_BASE}/api/entities?action=by-uris&uris=isbn:${isbn}&format=json`);
  if (!d || typeof d.entities !== 'object') return null;
  const entities = d.entities;
  const redirects = d.redirects || {};
  const editionUri = redirects['isbn:' + isbn] || ('isbn:' + isbn);
  const edition = entities[editionUri] || null;
  if (!edition || typeof edition.claims !== 'object') return null;
  const p629 = edition.claims['wdt:P629'];
  if (!Array.isArray(p629)) return null;
  for (const v of p629) {
    if (isInvWorkUri(v)) return v;
  }
  return null;
}

/* ---------------- phases ---------------- */

async function phase1Harvest() {
  const rows = sql(
    "select w.id as work_id, w.title, w.provider_ids, " +
    "array_remove(array_agg(distinct b.data->>'hcId'), null) as hc_ids, " +
    "array_remove(array_agg(distinct b.data->>'workKey'), null) as work_keys " +
    "from works w " +
    "left join editions e on e.work_id = w.id " +
    "left join books b on nullif(regexp_replace(b.data->>'isbn','[^0-9Xx]','','g'),'') " +
    "  = nullif(regexp_replace(e.isbn,'[^0-9Xx]','','g'),'') " +
    "group by w.id, w.title order by w.title");
  let filled = 0, skipped = 0;
  for (const r of rows) {
    const add = {};
    const hc = (r.hc_ids || []).filter(isHardcoverId);
    if (hc.length && consensus(hc)) add.hardcover_id = consensus(hc);
    const ol = (r.work_keys || []).filter(isOlWorkKey);
    if (ol.length && consensus(ol)) add.openlibrary_id = consensus(ol);
    const merged = mergeProviderIds(r.provider_ids, add);
    const keys = Object.keys(add);
    if (!merged) { skipped++; continue; }
    if (APPLY) {
      sql("update works set provider_ids = " + lit(JSON.stringify(merged)) +
        "::jsonb where id = " + lit(r.work_id));
      logProgress({ work_id: r.work_id, phase: 1, status: 'ok',
        filled: keys, at: new Date().toISOString() });
      filled++;
    } else {
      console.log(`would fill ${r.work_id} (${r.title}): ${keys.join(', ')}`);
    }
    if (LIMIT > 0 && (filled + skipped) >= LIMIT) break;
  }
  console.log(`phase 1 harvest: ${APPLY ? filled + ' filled' : 'report only'}, ${skipped} already complete`);
}

async function phase2Lookup(done) {
  const rows = sql(
    "select w.id as work_id, w.title, w.provider_ids, " +
    "array_remove(array_agg(distinct e.isbn), null) as isbns " +
    "from works w join editions e on e.work_id = w.id " +
    "where (w.provider_ids->>'openlibrary_id' is null " +
    "   or w.provider_ids->>'inventaire_id' is null) " +
    "group by w.id, w.title order by w.title");
  let filled = 0, conflicts = 0, unresolved = 0;
  for (const r of rows) {
    if (done.has(r.work_id)) continue;
    const isbns = (r.isbns || []).filter(isIsbn);
    const olKeys = [], invUris = [];
    for (const isbn of isbns) {
      const ok = await olWorkKeyForIsbn(isbn);
      if (ok) olKeys.push(ok);
      await sleep(PACE_MS);
      const iu = await invWorkUriForIsbn(isbn);
      if (iu) invUris.push(iu);
      await sleep(PACE_MS);
    }
    const add = {};
    const needOl = !(r.provider_ids && r.provider_ids.openlibrary_id);
    const needInv = !(r.provider_ids && r.provider_ids.inventaire_id);
    let conflictDetail = null;
    if (needOl && olKeys.length) {
      const c = consensus(olKeys);
      if (c) add.openlibrary_id = c;
      else conflictDetail = 'openlibrary: ' + [...new Set(olKeys)].join(' vs ');
    }
    if (needInv && invUris.length) {
      const c = consensus(invUris);
      if (c) add.inventaire_id = c;
      else conflictDetail = (conflictDetail ? conflictDetail + '; ' : '') +
        'inventaire: ' + [...new Set(invUris)].join(' vs ');
    }
    const merged = mergeProviderIds(r.provider_ids, add);
    if (conflictDetail) {
      console.log(`conflict ${r.work_id} (${r.title}): ${conflictDetail} — not written`);
      logProgress({ work_id: r.work_id, phase: 2, status: 'conflict',
        detail: conflictDetail, at: new Date().toISOString() });
      conflicts++;
    } else if (!merged) {
      unresolved++;
    } else if (APPLY) {
      sql("update works set provider_ids = " + lit(JSON.stringify(merged)) +
        "::jsonb where id = " + lit(r.work_id));
      logProgress({ work_id: r.work_id, phase: 2, status: 'ok',
        filled: Object.keys(add), at: new Date().toISOString() });
      console.log(`ok ${r.work_id} (${r.title}): ${Object.keys(add).join(', ')}`);
      filled++;
    } else {
      console.log(`would fill ${r.work_id} (${r.title}): ${Object.keys(add).join(', ')}`);
    }
    if (LIMIT > 0 && (filled + conflicts + unresolved) >= LIMIT) break;
  }
  console.log(`phase 2 lookup: ${filled} filled, ${conflicts} conflicts, ${unresolved} unresolved/no-change`);
}

async function phase3DedupeReport() {
  const rows = sql(
    "select title_norm, count(*) as n, " +
    "array_agg(id order by id) as ids, " +
    "array_agg(distinct author_norm order by author_norm) as authors, " +
    "array_agg(distinct title order by title) as titles " +
    "from works group by title_norm having count(*) > 1 order by title_norm");
  if (!rows.length) { console.log('no duplicate-title groups found'); return; }
  console.log(`${rows.length} title groups with multiple work rows (review only — no merges performed):\n`);
  for (const g of rows) {
    console.log(`- "${(g.titles || [])[0]}" [${g.n} rows]`);
    console.log(`  ids:     ${(g.ids || []).join(', ')}`);
    console.log(`  authors: ${(g.authors || []).join(' | ')}`);
  }
  console.log('\nMerge candidates above. Merging is destructive — needs your explicit call.');
}

/* ---------------- selftest (no DB, no network) ---------------- */

function selftest() {
  const assert = require('assert');
  assert.strictEqual(normIdent('The Hunger Games'), 'hunger games');
  assert.strictEqual(normIdent('Café Society'), 'cafe society');
  assert.strictEqual(normIdent('  Dune: Part Two '), 'dune part two');
  assert.ok(isOlWorkKey('/works/OL82563W'));
  assert.ok(!isOlWorkKey('/books/OL82563M'));
  assert.ok(!isOlWorkKey('OL82563W'));
  assert.ok(isInvWorkUri('wd:Q123'));
  assert.ok(!isInvWorkUri('isbn:9780140328721'));
  assert.ok(isHardcoverId('123456'));
  assert.ok(!isHardcoverId('abc'));
  assert.ok(isIsbn('9780140328721') && isIsbn('0140328726'));
  assert.ok(!isIsbn('978-0-14-032872-1'));
  assert.strictEqual(consensus(['/works/OL1W', '/works/OL1W']), '/works/OL1W');
  assert.strictEqual(consensus([]), null);
  assert.strictEqual(consensus(['/works/OL1W', '/works/OL2W']), null);
  const m1 = mergeProviderIds({}, { openlibrary_id: '/works/OL1W' });
  assert.deepStrictEqual(m1, { openlibrary_id: '/works/OL1W' });
  assert.strictEqual(mergeProviderIds({ openlibrary_id: '/works/OL1W' },
    { openlibrary_id: '/works/OL1W' }), null); // no-op, nothing changes
  // never clobbers: a different incoming value does not overwrite
  const m2 = mergeProviderIds({ openlibrary_id: '/works/OL1W' },
    { openlibrary_id: '/works/OL2W', inventaire_id: 'wd:Q9' });
  assert.deepStrictEqual(m2, { openlibrary_id: '/works/OL1W', inventaire_id: 'wd:Q9' });
  console.log('selftest: all assertions passed');
}

async function main() {
  if (SELFTEST) { selftest(); return; }
  if (DEDUPE_ONLY) { await phase3DedupeReport(); return; }
  console.log(APPLY ? 'APPLY mode: phases 1+2 will write' : 'REPORT mode: no writes (add --apply to write)');
  const done = new Set();
  if (fs.existsSync(progressPath)) {
    for (const line of fs.readFileSync(progressPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.work_id && (e.status === 'ok' || e.status === 'skip')) done.add(e.work_id);
      } catch {}
    }
  }
  await phase1Harvest();
  await phase2Lookup(done);
  console.log('\nRun with --dedupe-report for the read-only duplicate-work candidate list.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
