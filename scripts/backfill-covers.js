#!/usr/bin/env node
/* One-off cover canonicalization backfill (v216).
   Sends every stored remote cover URL through the production /api/cache-cover
   proxy (fetch + hash + deduped upload happen server-side) and writes the
   canonical bucket URL back to books.data->cover, bumping data->_mtime so
   devices pull it through the normal sync merge.

   Books whose covers already point at the bucket, are data: uploads, or live
   on hosts outside the function allowlist are skipped (their remote URLs keep
   working — nothing breaks, they just don't get the dedup benefits).

   Usage:
     LIMIT=1 node scripts/backfill-covers.js   # probe: one book, no writes
     node scripts/backfill-covers.js           # full run (background it)
   Progress: scripts/cover-backfill-progress.jsonl (resume skips 'ok'/'skip')
   Env: COVER_BASE (default https://cozylibram.pages.dev/api/cache-cover)
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SB = '/home/hatch/workspace/skills/supabase/bin/sb-query';
const REF = 'dvhimjkrroxuatthiizc';
const APP = '/home/hatch/workspace/booktok';
const PROXY = (process.env.COVER_BASE || 'https://cozylibram.pages.dev/api/cache-cover').replace(/\/+$/, '');
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const PROBE = LIMIT === 1;
const PACE_MS = 500; // ~2 req/s, well under the function's 300/min limit

// Mirrors functions/api/cache-cover.js ALLOWED_HOSTS (2026-09-30).
const ALLOWED_HOSTS = new Set([
  'covers.openlibrary.org', 'books.google.com', 'assets.hardcover.app',
  'images-na.ssl-images-amazon.com', 'm.media-amazon.com', 'i.gr-assets.com',
  'archive.org',
  'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com',
]);
const CANON_MARK = '/storage/v1/object/public/covers/';

const sql = q => JSON.parse(
  execFileSync(SB, [REF, q], { maxBuffer: 256 * 1024 * 1024 }).toString());
const lit = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const progressPath = path.join(APP, 'scripts', 'cover-backfill-progress.jsonl');
function logProgress(obj) {
  fs.appendFileSync(progressPath, JSON.stringify(obj) + '\n');
}
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

async function main() {
  const done = new Set();
  if (fs.existsSync(progressPath)) {
    for (const line of fs.readFileSync(progressPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && (e.status === 'ok' || e.status === 'skip')) done.add(e.id);
      } catch {}
    }
  }
  const rows = sql(
    "select id, user_id, data->>'cover' as cover from books " +
    "where data->>'cover' like 'http%' order by user_id, id");
  const targets = rows.filter(r => !done.has(r.id));
  console.log(`${rows.length} books with remote covers, ${targets.length} to process`);

  let ok = 0, kept = 0, failed = 0;
  for (const r of targets) {
    const cover = r.cover || '';
    const finish = (status, detail) => {
      logProgress({ id: r.id, status, detail: detail || undefined, at: new Date().toISOString() });
    };
    if (cover.includes(CANON_MARK)) { finish('skip', 'already canonical'); kept++; continue; }
    if (!ALLOWED_HOSTS.has(hostOf(cover))) {
      console.log(`skip ${r.id}: host not on allowlist (${hostOf(cover)}) — kept remote`);
      finish('skip', 'host not on allowlist');
      kept++;
      continue;
    }
    let res, body;
    try {
      res = await fetch(PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cover }),
      });
      body = await res.text();
    } catch (e) {
      console.log(`FAIL ${r.id}: proxy unreachable (${e.message}) — kept remote`);
      finish('error', 'proxy unreachable');
      failed++;
      continue;
    }
    if (!res.ok) {
      console.log(`kept ${r.id}: proxy ${res.status} — kept remote`);
      finish('skip', 'proxy ' + res.status);
      kept++;
      continue;
    }
    let canon;
    try { canon = JSON.parse(body).coverUrl; } catch { canon = null; }
    if (typeof canon !== 'string' || !canon.startsWith('https://')) {
      console.log(`FAIL ${r.id}: unexpected proxy shape — kept remote`);
      finish('error', 'unexpected shape');
      failed++;
      continue;
    }
    if (PROBE) {
      console.log(`PROBE ${r.id}: would write ${canon}`);
      finish('skip', 'probe');
      kept++;
      break;
    }
    const ms = Date.now();
    sql("update books set data = jsonb_set(jsonb_set(data, '{cover}', to_jsonb(" +
      lit(canon) + "::text)), '{_mtime}', to_jsonb(" + ms + "::bigint)), " +
      "updated_at = now() where id = " + lit(r.id));
    console.log(`ok ${r.id}: ${canon.slice(-72)}`);
    finish('ok');
    ok++;
    if (LIMIT > 1 && ok >= LIMIT) break;
    await sleep(PACE_MS);
  }
  console.log(`\ndone: ${ok} canonicalized, ${kept} kept remote, ${failed} failed`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
