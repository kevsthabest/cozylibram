// Tests for v459 — Community corpus refinement v1.
// Covers: rate limiter, obscurity weighting, tier weights, milestone catalog,
// SQL migration structure (additive-only), trigger taxonomy seed validity.

const fs = require('fs');
const path = require('path');
const { classicize } = require('./harness');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

/* ---------- pure module logic (no DOM needed) ---------- */
// R3 repoint (migration plan §9.3): js/222 is a real ES module since
// phase 2 batch 6. classicize restores the classic body before
// evaluation (identity on a classic file). A converted file has no
// IIFE wrapper to strip — and the strip patterns could match nested
// callbacks — so the strip below runs only when classicize changed
// nothing, i.e. the target is still a classic IIFE file. Loading
// plumbing only — assertions untouched.
const rawSrc = fs.readFileSync(path.join(ROOT, 'js/222-community-corpus.js'), 'utf8');
let src = classicize(rawSrc, 'js/222-community-corpus.js');
if (src === rawSrc) src = src.replace(/\(function \(\) \{/, '').replace(/\}\)\(\);?\s*$/, '');
// Stub browser globals the module touches at load time
const localStore = {};
global.localStorage = {
  getItem: k => (k in localStore ? localStore[k] : null),
  setItem: (k, v) => { localStore[k] = String(v); },
  removeItem: k => { delete localStore[k]; }
};
global.window = {};
const moduleObj = { exports: {} };
new Function('module', 'window', 'localStorage', 'toast', 'cloudClient', 'cloudUser', 'bookKeyFor', 'document',
  src.replace("if (typeof window !== 'undefined') window.CommunityCorpus = CommunityCorpus;", 'window.CommunityCorpus = CommunityCorpus;')
    .replace("if (typeof module !== 'undefined') module.exports = CommunityCorpus;", 'module.exports = CommunityCorpus;')
)(moduleObj, global.window, global.localStorage, function () {}, null, null, null, { readyState: 'complete', addEventListener: function () {} });
const CC = moduleObj.exports;

/* Rate limiter */
{
  CC._test.rateLimitReset();
  let r = CC._test.rateLimitCheck();
  ok('rate limit: first call ok', r.ok === true);
  for (let i = 0; i < 19; i++) CC._test.rateLimitCheck();
  r = CC._test.rateLimitCheck();
  ok('rate limit: 21st call in hour blocked', r.ok === false && r.scope === 'hour');
  ok('rate limit: retryAfterMs positive', r.retryAfterMs > 0);
  CC._test.rateLimitReset();
  r = CC._test.rateLimitCheck();
  ok('rate limit: reset restores', r.ok === true);
}

/* Obscurity weighting: 1/(1+n) */
{
  ok('obscurity: n=0 -> 1', CC._test.obscurity(0) === 1);
  ok('obscurity: n=1 -> 0.5', CC._test.obscurity(1) === 0.5);
  ok('obscurity: n=3 -> 0.25', CC._test.obscurity(3) === 0.25);
  ok('obscurity: decreasing', CC._test.obscurity(9) < CC._test.obscurity(0));
}

/* Tier weights (dormant in v1, model final) */
{
  ok('tier weight: member=1', CC._test.tierWeight('member') === 1);
  ok('tier weight: established=2', CC._test.tierWeight('established') === 2);
  ok('tier weight: verified=3', CC._test.tierWeight('verified') === 3);
  ok('tier weight: unknown defaults 1', CC._test.tierWeight('nobody') === 1);
}

/* ---------- milestone catalog (parse from source) ---------- */
{
  const ms = fs.readFileSync(path.join(ROOT, 'js/219-milestones.js'), 'utf8');
  ['lore-trope-archivist', 'lore-dramatis-personae', 'lore-lookout'].forEach(id => {
    ok('milestone catalog has ' + id, ms.indexOf("id: '" + id + "'") >= 0);
  });
  ok('milestones: accepted-only detector exists', ms.indexOf('checkCommunityMilestones') >= 0);
  ok('milestones: weighted threshold 3', /\[.lore-trope-archivist., counts\.tropeW/.test(ms));
}

/* ---------- SQL migration: additive-only ---------- */
{
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/v399_community_corpus_v1.sql'), 'utf8');
  const lower = sql.toLowerCase();
  ok('sql: no drop table', !/drop\s+table/i.test(sql));
  ok('sql: no delete from', !/delete\s+from/i.test(sql));
  ok('sql: no truncate', !/truncate/i.test(sql));
  ok('sql: character_suggestions table', /create table if not exists public\.character_suggestions/i.test(sql));
  ok('sql: trigger_taxonomy table', /create table if not exists public\.trigger_taxonomy/i.test(sql));
  ok('sql: trigger_suggestions table', /create table if not exists public\.trigger_suggestions/i.test(sql));
  ok('sql: community_votes table', /create table if not exists public\.community_votes/i.test(sql));
  ok('sql: community_tiers table', /create table if not exists public\.community_tiers/i.test(sql));
  ok('sql: no-self-vote trigger', /community_votes_no_self/i.test(sql));
  ok('sql: merge requires evidence (check constraint)', /character_suggestions_merge_evidence/i.test(sql));
  ok('sql: tier weight function', /community_tier_weight/i.test(sql));
  ok('sql: trope_proposals kind column', /add column if not exists kind/i.test(sql));
  ok('sql: trope_proposals obscurity_weight', /trope_proposals[\s\S]{0,400}obscurity_weight/i.test(sql));
  // every new table has RLS enabled
  ['character_suggestions', 'trigger_taxonomy', 'trigger_suggestions', 'community_votes', 'community_tiers'].forEach(t => {
    ok('sql: RLS on ' + t, new RegExp('alter table public\\.' + t + ' enable row level security', 'i').test(sql));
  });
}

/* ---------- trigger taxonomy seed ---------- */
{
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/v399_community_corpus_v1.sql'), 'utf8');
  const seedBlock = sql.slice(sql.indexOf('-- 7. Trigger taxonomy seed'));
  const ids = [...seedBlock.matchAll(/\('([a-z0-9-]+)',/g)].map(m => m[1]);
  ok('taxonomy seed: has entries', ids.length >= 20);
  ok('taxonomy seed: ids are slugs', ids.every(id => /^[a-z0-9-]+$/.test(id)));
  ok('taxonomy seed: ids unique', new Set(ids).size === ids.length);
  ok('taxonomy seed: covers violence', ids.some(id => id.indexOf('violence') === 0));
  ok('taxonomy seed: covers mental health', ids.some(id => id.indexOf('mental-') === 0));
  ok('taxonomy seed: on-conflict do nothing (idempotent)', /on conflict \(id\) do nothing/i.test(seedBlock));
}

/* ---------- UI module: key flows present ---------- */
{
  const ui = fs.readFileSync(path.join(ROOT, 'js/223-community-corpus-ui.js'), 'utf8');
  ok('ui: trope picker', ui.indexOf('openTropePicker') >= 0);
  ok('ui: catalog-only note', /89/.test(ui) || /catalog/.test(ui));
  ok('ui: new trope idea flow', ui.indexOf('openNewTropeIdea') >= 0);
  ok('ui: character suggest', ui.indexOf('openCharacterSuggest') >= 0);
  ok('ui: merge proposal with evidence', ui.indexOf('openMergeProposal') >= 0 && ui.indexOf('Evidence (required)') >= 0);
  ok('ui: trigger picker', ui.indexOf('openTriggerPicker') >= 0);
  ok('ui: flywheel enrichment', ui.indexOf('ccEnrichWarnings') >= 0);
  ok('ui: exposes ccSetBook', ui.indexOf('ccSetBook') >= 0);
  ok('ui: conversation flow (Who did we miss?)', ui.indexOf('Who did we miss?') >= 0);
  ok('ui: merge side-by-side cards', ui.indexOf('cc-merge-cards') >= 0);
  ok('ui: trust notes quiet (cc-trust)', ui.indexOf('cc-trust') >= 0);
  ok('ui: quiet entry badges', ui.indexOf('cc-entry') >= 0);
}

/* ---------- wiki provenance pills (Variant A quiet badges) ---------- */
{
  const ch = fs.readFileSync(path.join(ROOT, 'js/159-characters.js'), 'utf8');
  ok('wiki: provPill helper', ch.indexOf('function provPill') >= 0);
  ok('wiki: pill pairs color with text', /provPill\('(community|pending)'\)/.test(ch) || ch.indexOf("provPill('pending')") >= 0);
  ok('wiki: aliases quiet row (no pill)', ch.indexOf('ch-aliases') >= 0);
  ok('wiki: description pill', ch.indexOf('provPill(d.source)') >= 0);
  ok('wiki: instance pills', ch.indexOf('provPill(inst.sourceType)') >= 0);
  ok('wiki: pending count (no unreviewed content)', ch.indexOf('pendingCount') >= 0);
  ok('wiki: voting surface parked (comment)', /voting surface.*parked/i.test(ch));
  // CharacterStore (and its canonical detail query) moved to
  // js/154-characterstore.js — same assertion, new home.
  const admin = fs.readFileSync(path.join(ROOT, 'js/154-characterstore.js'), 'utf8');
  ok('wiki: source_type in canonical detail query', admin.indexOf('source_type') >= 0);
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  ok('css: prov-pill styles', css.indexOf('.prov-pill') >= 0);
  ok('css: cc-trust 11px', /\.cc-trust\s*\{[^}]*font-size:\s*11px/.test(css));
}

/* ---------- curation queue ---------- */
{
  const cq = fs.readFileSync(path.join(ROOT, 'js/224-curation-queue.js'), 'utf8');
  ok('curation: bulk approve/reject', cq.indexOf('cq-approve-sel') >= 0 && cq.indexOf('cq-reject-sel') >= 0);
  ok('curation: consensus display', cq.indexOf('consensus') >= 0);
  ok('curation: provenance shown (suggester)', cq.indexOf('names[') >= 0 || cq.indexOf('profiles') >= 0);
  ok('curation: trope approve upserts book_tropes community', /book_tropes.*source.*community|source: 'community'/.test(cq));
  ok('curation: counters bumped', cq.indexOf('bumpCounters') >= 0);
  ok('curation: merge never auto-applied (note)', /never auto-applied|manually/i.test(cq));
  const admin = fs.readFileSync(path.join(ROOT, 'js/199-admin.js'), 'utf8');
  ok('curation: tab wired in Observatory', admin.indexOf("adminTab === 'curation'") >= 0);
}

/* ---------- touchpoints ---------- */
{
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ['js/222-community-corpus.js', 'js/223-community-corpus-ui.js', 'js/224-curation-queue.js'].forEach(f => {
    ok('index.html includes ' + f, idx.indexOf(f) >= 0);
  });
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ['222-community-corpus.js', '223-community-corpus-ui.js', '224-curation-queue.js'].forEach(f => {
    ok('sw.js precaches ' + f, sw.indexOf(f) >= 0);
  });
  const av = fs.readFileSync(path.join(ROOT, 'js/181-appversion.js'), 'utf8');
  const avn = parseInt((av.match(/v(\d+)/) || [])[1] || '0', 10);
  ok('version bumped past v474', avn > 474);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
