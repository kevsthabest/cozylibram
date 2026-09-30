#!/usr/bin/env node
/* One-off embedding backfill (v213).
   Embeds every work in the library with @cf/baai/bge-m3 via the production
   /api/embed proxy (keys stay server-side — the proxy uses the Workers AI
   binding) and writes the 1024-dim vectors to works.embedding.

   Embed text per work: "TITLE — authors. DESCRIPTION. Tropes: a, b. Genres:
   x, y." — built by the app's own buildEmbedText() (js/198-discovery.js),
   loaded in a vm so the client and the backfill can never drift. Trope
   names come from confirmed book_trope_claims; description/genres from the
   richest books.data row resolving to the work (same normIdent grouping the
   reclassify script uses).

   Usage:
     LIMIT=1 node scripts/backfill-embeddings.js   # probe: one work, no writes
     node scripts/backfill-embeddings.js           # full run (background it)
   Progress: scripts/embed-progress.jsonl (resume skips 'ok' entries)
   Env: EMBED_BASE (default https://cozylibram.pages.dev/api/embed)
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const SB = '/home/hatch/workspace/skills/supabase/bin/sb-query';
const REF = 'dvhimjkrroxuatthiizc';
const APP = '/home/hatch/workspace/booktok';
const PROXY = (process.env.EMBED_BASE || 'https://cozylibram.pages.dev/api/embed').replace(/\/+$/, '');
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const PROBE = LIMIT === 1;
const BATCH = 50;               // proxy cap
const PACE_MS = 2500;           // under the proxy's 30 req/min rate limit

const sql = q => JSON.parse(
  execFileSync(SB, [REF, q], { maxBuffer: 256 * 1024 * 1024 }).toString());
const lit = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const progressPath = path.join(APP, 'scripts', 'embed-progress.jsonl');
function logProgress(obj) {
  fs.appendFileSync(progressPath, JSON.stringify(obj) + '\n');
}

/* --- app JS in a sandbox (buildEmbedText + tropeNormIdent) --- */
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  SPICY_CONFIG: {}, library: [], cloudClient: async () => null,
  fetch: async () => { throw new Error('no fetch in backfill'); },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['156-trope-taxonomy.js', '157-trope-inference.js', '198-discovery.js']) {
  vm.runInContext(fs.readFileSync(path.join(APP, 'js', f), 'utf8'), ctx, { filename: f });
}
const buildEmbedText = vm.runInContext('buildEmbedText', ctx);
const normIdent = vm.runInContext('tropeNormIdent', ctx);
if (!buildEmbedText || !normIdent) throw new Error('app JS failed to load');

async function embedBatch(texts) {
  const res = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error('embed proxy ' + res.status + ': ' + body.slice(0, 300));
  const data = JSON.parse(body);
  if (!Array.isArray(data.vectors) || data.vectors.length !== texts.length) {
    throw new Error('embed proxy returned an unexpected shape');
  }
  return data.vectors;
}

function vectorLit(v) {
  return "'[" + v.map(n => {
    const x = Number(n);
    if (!Number.isFinite(x)) throw new Error('non-finite embedding component');
    return x.toPrecision(8);
  }).join(',') + "]'";
}

async function main() {
  console.log('proxy:', PROXY, PROBE ? '| PROBE MODE (no writes)' : '');

  // Confirmed trope names per work (display names; resolver not needed here —
  // embed text is free text, not taxonomy ids).
  const claims = sql(`select work_id, trope_id from book_trope_claims ` +
    `where status='confirmed';`);
  const tropesByWork = new Map();
  for (const c of claims) {
    if (!c || !c.work_id || !c.trope_id) continue;
    if (!tropesByWork.has(c.work_id)) tropesByWork.set(c.work_id, []);
    tropesByWork.get(c.work_id).push(String(c.trope_id).replace(/-/g, ' '));
  }
  console.log('works with confirmed tropes:', tropesByWork.size);

  // Richest book-data row per work (same grouping as reclassify-tropes.js).
  const books = sql(`select data->>'title' as title, data->'authors' as authors, ` +
    `data->>'description' as description, data->'categories' as categories, ` +
    `data->'tropes' as tropes from books;`);
  console.log('book rows:', books.length);
  const works = new Map();
  for (const b of books) {
    const title = b.title || '';
    const authors = Array.isArray(b.authors) ? b.authors.map(String) : [];
    const tn = normIdent(title), an = normIdent(authors.join(' '));
    if (!tn) continue;
    const key = tn + '' + an;
    let w = works.get(key);
    if (!w) {
      w = { title, authors, tn, an, description: '', categories: [], tropes: [] };
      works.set(key, w);
    }
    const d = b.description || '';
    if (d.length > w.description.length) {
      w.description = d;
      w.categories = Array.isArray(b.categories) ? b.categories.map(String) : [];
      w.tropes = Array.isArray(b.tropes) ? b.tropes.map(String) : [];
    }
  }

  // Join to works rows missing embeddings.
  const pending = sql(`select id, title, title_norm, author_norm from works ` +
    `where embedding is null;`);
  console.log('works pending embeddings:', pending.length);
  const byKey = new Map();
  for (const w of works.values()) byKey.set(w.tn + '' + w.an, w);

  let list = pending.map(p => {
    const agg = byKey.get((p.title_norm || '') + '' + (p.author_norm || ''));
    const confirmed = tropesByWork.get(p.id) || [];
    const seen = new Set();
    const tropes = (agg && agg.tropes || []).concat(confirmed)
      .map(String).filter(t => t && !seen.has(t = t.trim().toLowerCase()) && (seen.add(t), true));
    return {
      id: p.id,
      title: (agg && agg.title) || p.title,
      authors: (agg && agg.authors) || [],
      description: (agg && agg.description) || '',
      categories: (agg && agg.categories) || [],
      tropes,
    };
  }).filter(w => w.title);
  if (LIMIT > 0) list = list.slice(0, LIMIT);

  // Resume: skip works already 'ok' in a previous run's progress log.
  let resumed = 0;
  if (!PROBE && fs.existsSync(progressPath)) {
    const done = new Set();
    for (const line of fs.readFileSync(progressPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && e.ok && e.work_id) done.add(e.work_id);
      } catch (x) {}
    }
    const before = list.length;
    list = list.filter(w => !done.has(w.id));
    resumed = before - list.length;
  }
  console.log('to embed:', list.length, resumed ? `(resumed ${resumed})` : '');

  let ok = 0, failed = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    const texts = chunk.map(w => buildEmbedText({
      title: w.title, authors: w.authors, description: w.description,
      tropes: w.tropes, genres: w.categories,
    }));
    let vectors;
    try {
      vectors = await embedBatch(texts);
    } catch (e) {
      console.error('batch failed:', e.message);
      for (const w of chunk) logProgress({ work_id: w.id, title: w.title, ok: false, error: e.message });
      failed += chunk.length;
      await sleep(PACE_MS);
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const w = chunk[j], v = vectors[j];
      try {
        if (PROBE) {
          console.log('PROBE dims:', v.length, '| text head:', texts[j].slice(0, 80));
          // PROBE writes nothing: do NOT log ok, or the real run would skip this work.
        } else {
          sql(`update works set embedding=${vectorLit(v)}::vector where id=${lit(w.id)};`);
          logProgress({ work_id: w.id, title: w.title, ok: true, dims: v.length });
        }
        ok++;
      } catch (e) {
        logProgress({ work_id: w.id, title: w.title, ok: false, error: e.message });
        failed++;
      }
    }
    console.log(`progress: ${ok} ok, ${failed} failed (${i + chunk.length}/${list.length})`);
    await sleep(PACE_MS);
  }
  console.log(`done: ${ok} embedded, ${failed} failed`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
