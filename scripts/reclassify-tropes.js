#!/usr/bin/env node
/* One-off batch reclassification (2026-09-30, Kevin-approved).
   Re-runs trope inference for every work in the library under the v208
   evidence pipeline, writing claims through the v208 write path:
   rejected tropes are never resurrected, human-confirmed ones never
   demoted, AI regenerable rows (candidates + auto-confirmed) are
   replaced, and high-confidence results with verified description
   quotes auto-publish as confirmed.

   Uses the app's own JS (prompt builder, response parser, alias-aware
   validator, work-key normalizer) loaded in a vm, and the production
   /api/trope-infer proxy (keys stay server-side) with the shared
   trope_provider_settings provider/model (Gemini preferred).

   Usage:
     LIMIT=1 node scripts/reclassify-tropes.js   # probe: one work, no writes
     node scripts/reclassify-tropes.js           # full run (background it)
   Progress: scripts/reclassify-progress.jsonl
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const SB = '/home/hatch/workspace/skills/supabase/bin/sb-query';
const REF = 'dvhimjkrroxuatthiizc';
const PROXY = 'https://cozylibram.pages.dev/api/trope-infer';
const APP = '/home/hatch/workspace/booktok';
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const PROBE = LIMIT === 1;
const PACE_MS = 2600; // under the proxy's 30 req/min rate limit

const sql = q => JSON.parse(
  execFileSync(SB, [REF, q], { maxBuffer: 256 * 1024 * 1024 }).toString());
const lit = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --- app JS in a sandbox --- */
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  SPICY_CONFIG: {}, library: [], cloudClient: async () => null,
  fetch: async () => { throw new Error('no fetch in reclassify'); },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['156-trope-taxonomy.js', '157-trope-inference.js', '158-works.js']) {
  vm.runInContext(fs.readFileSync(path.join(APP, 'js', f), 'utf8'), ctx, { filename: f });
}
const normIdent = vm.runInContext('tropeNormIdent', ctx);
const buildTropePrompt = vm.runInContext('buildTropePrompt', ctx);
const parseTropeResponse = vm.runInContext('parseTropeResponse', ctx);
const validateTropeResults = vm.runInContext('validateTropeResults', ctx);
const TROPE_CONFIDENCE_TIERS = vm.runInContext('TROPE_CONFIDENCE_TIERS', ctx);
const tropeInputHash = vm.runInContext('tropeInputHash', ctx);
const TROPE_TAXONOMY_VERSION = vm.runInContext('TROPE_TAXONOMY_VERSION', ctx);

function logProgress(obj) {
  fs.appendFileSync(path.join(APP, 'scripts', 'reclassify-progress.jsonl'),
    JSON.stringify(obj) + '\n');
}

async function inferWork(w, provider, model) {
  const book = {
    title: w.title, authors: w.authors, categories: w.categories,
    description: w.description, isbn: [...w.isbns][0] || '',
  };
  const { system, user } = buildTropePrompt(book);
  let maxTokens = 1600; // evidence quotes make responses longer
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let resp;
    try {
      resp = await fetch(PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider, model, max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error('proxy network error: ' + (e.message || e));
    }
    clearTimeout(timer);
    if (resp.status === 502) {
      const b = await resp.json().catch(() => null);
      if (b && b.error === 'truncated' && maxTokens < 4000) {
        maxTokens = Math.min(4000, maxTokens * 2);
        continue;
      }
      throw new Error('provider 502: ' + JSON.stringify(b).slice(0, 200));
    }
    if (resp.status === 503) {
      const t = await resp.text().catch(() => '');
      throw new Error('provider 503 (overloaded or no key): ' + t.slice(0, 200));
    }
    if (!resp.ok) {
      throw new Error('proxy HTTP ' + resp.status + ': ' +
        (await resp.text().catch(() => '')).slice(0, 200));
    }
    const data = await resp.json();
    const text = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    const raw = parseTropeResponse(text);
    // v208: description passed so evidence quotes are verified as literal substrings
    return { tropes: validateTropeResults(raw, book.description), model: provider + '/' + model };
  }
  throw new Error('exhausted retries');
}

/* v208 write path in SQL: filter rejected + human-confirmed, replace AI
   regenerable rows (candidates + auto-confirmed) by id, and auto-publish
   high-confidence tropes with verified evidence as confirmed. */
function evObj(c) {
  const e = c.evidence;
  if (e && typeof e === 'object') return e;
  if (typeof e === 'string') { try { return JSON.parse(e); } catch (_) {} }
  return {};
}
function writeClaims(workId, book, tropes, model) {
  const existing = sql(
    `select id, trope_id, status, source_type, evidence from book_trope_claims ` +
    `where work_id=${lit(workId)};`);
  const rejected = new Set(), protected_ = new Set(), regenIds = [];
  for (const c of existing) {
    if (c.status === 'rejected') { rejected.add(c.trope_id); continue; }
    if (c.status === 'confirmed' && !evObj(c).auto_confirmed) {
      protected_.add(c.trope_id); continue; // human/community confirmed: never demoted
    }
    if (c.source_type === 'ai' &&
        (c.status === 'candidate' ||
         (c.status === 'confirmed' && evObj(c).auto_confirmed)) && c.id) {
      regenIds.push(c.id);
    }
  }
  const fresh = (tropes || []).filter(t => t && t.id &&
    !rejected.has(t.id) && !protected_.has(t.id));
  if (regenIds.length) {
    // ids are uuids: quote each one
    sql(`delete from book_trope_claims where id in (${regenIds.map(u => lit(u)).join(',')});`);
  }
  if (!fresh.length) return { inserted: 0, auto: 0, skippedRejected:
    (tropes || []).filter(t => t && rejected.has(t.id)).length };
  const inputHash = tropeInputHash({
    title: book.title, authors: book.authors,
    description: book.description, categories: book.categories });
  const vals = fresh.map(t => {
    const ev = Array.isArray(t.evidence) ? t.evidence : [];
    const auto = t.confidence >= TROPE_CONFIDENCE_TIERS.high && ev.length > 0;
    const evidence = JSON.stringify({
      taxonomy_version: TROPE_TAXONOMY_VERSION, taxonomy_rev: 1,
      evidence: ev, input_hash: inputHash,
      ...(auto ? { auto_confirmed: true } : {}),
    });
    return `(${lit(workId)}, ${lit(t.id)}, ${auto ? "'confirmed'" : "'candidate'"}, ` +
      `${t.confidence}, 'ai', ${lit(model)}, null, ${lit(evidence)}::jsonb)`;
  }).join(',');
  const rows = sql(
    `insert into book_trope_claims ` +
    `(work_id, trope_id, status, confidence, source_type, model, model_version, evidence) ` +
    `values ${vals} returning trope_id, status;`);
  return { inserted: rows.length,
    auto: rows.filter(r => r.status === 'confirmed').length,
    skippedRejected: (tropes || []).filter(t => t && rejected.has(t.id)).length };
}

function resolveWorkRow(w) {
  const found = sql(`select id from works where title_norm=${lit(w.tn)} ` +
    `and author_norm=${lit(w.an)};`);
  if (found.length) return { id: found[0].id, created: false };
  const ins = sql(
    `insert into works (title, authors, title_norm, author_norm) values (` +
    `${lit(w.title)}, ${lit(JSON.stringify(w.authors))}::jsonb, ` +
    `${lit(w.tn)}, ${lit(w.an)}) ` +
    `on conflict (title_norm, author_norm) do update set title=excluded.title ` +
    `returning id;`);
  return { id: ins[0].id, created: true };
}

async function main() {
  const setting = sql('select provider, model from trope_provider_settings limit 1;')[0] || {};
  const provider = (setting.provider || 'gemini').toLowerCase();
  const model = setting.model || 'gemini-3.5-flash-lite';
  console.log('provider:', provider, '| model:', model, PROBE ? '| PROBE MODE' : '');

  const books = sql(`select id, user_id, isbn, data->>'title' as title, ` +
    `data->'authors' as authors, data->>'description' as description, ` +
    `data->'categories' as categories from books;`);
  console.log('books:', books.length);

  const works = new Map();
  for (const b of books) {
    const title = b.title || '';
    const authors = Array.isArray(b.authors) ? b.authors.map(String) : [];
    const tn = normIdent(title), an = normIdent(authors.join(' '));
    if (!tn) continue;
    const key = tn + '\x1f' + an;
    let w = works.get(key);
    if (!w) {
      w = { title, authors, tn, an, isbns: new Set(), books: 0,
            description: '', categories: [] };
      works.set(key, w);
    }
    w.books++;
    const digits = String(b.isbn || '').replace(/[^0-9]/g, '');
    if (digits.length === 13) w.isbns.add(digits);
    const d = b.description || '';
    if (d.length > w.description.length) {
      w.description = d;
      w.categories = Array.isArray(b.categories) ? b.categories.map(String) : [];
    }
  }
  let list = [...works.values()];
  console.log('unique works:', list.length);
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  // Resume: skip works already completed in a previous run's progress log.
  // (Only 'ok' entries are skipped; failures/skips are retried.)
  const progressPath = path.join(APP, 'scripts', 'reclassify-progress.jsonl');
  let resumed = 0;
  if (!PROBE && fs.existsSync(progressPath)) {
    const doneTitles = new Set();
    for (const line of fs.readFileSync(progressPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.status === 'ok' && e.work) doneTitles.add(e.work);
      } catch (_) {}
    }
    if (doneTitles.size) {
      list = list.filter(w => {
        if (doneTitles.has(w.title)) { resumed++; return false; }
        return true;
      });
      console.log(`resumed: skipping ${resumed} already-completed works, ${list.length} remaining`);
    }
  }

  let done = 0, failed = 0, insertedTotal = 0;
  for (const w of list) {
    const tag = `"${w.title}" (${w.authors.join(', ')})`;
    try {
      if (!w.description || w.description.length < 100) {
        console.log(`skip (thin description): ${tag}`);
        if (!PROBE) logProgress({ work: w.title, status: 'skipped-thin-desc' });
        continue;
      }
      const inf = await inferWork(w, provider, model);
      if (PROBE) {
        console.log('PROBE inference for', tag);
        console.log('tropes:', JSON.stringify(inf.tropes));
        console.log('model:', inf.model);
        return; // no writes in probe mode
      }
      const { id: workId, created } = resolveWorkRow(w);
      for (const isbn of w.isbns) {
        try {
          sql(`insert into editions (work_id, isbn) values ` +
              `(${lit(workId)}, ${lit(isbn)}) on conflict (isbn) do nothing;`);
        } catch (e) { /* best-effort */ }
      }
      const book = { title: w.title, authors: w.authors,
        description: w.description, categories: w.categories };
      const wr = writeClaims(workId, book, inf.tropes, inf.model);
      done++; insertedTotal += wr.inserted;
      console.log(`ok [${done}/${list.length}] ${tag} -> ` +
        `${wr.inserted} claims (${wr.auto} auto)` +
        (wr.skippedRejected ? ` (${wr.skippedRejected} rejected kept)` : '') +
        (created ? ' (new work)' : ''));
      logProgress({ work: w.title, workId, status: 'ok',
        inserted: wr.inserted, auto: wr.auto, skippedRejected: wr.skippedRejected,
        tropes: inf.tropes.map(t => ({ id: t.id, c: t.confidence,
          ev: (t.evidence || []).length })) });
    } catch (e) {
      failed++;
      console.log(`FAIL ${tag}: ${e.message}`);
      logProgress({ work: w.title, status: 'failed', error: e.message });
    }
    await sleep(PACE_MS);
  }
  console.log(`\ndone: ${done} works, ${insertedTotal} claims, ${failed} failed`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
