// Tests for v194 — security hardening.
//
// Covered:
//  1. migrateBook neutralizes attacker-controlled `id` / `status` at the
//     trust boundary (friend libraries, cloud rows, imports all pass
//     through it).
//  2. bookCard / bookTile / statusbar escape id + status at the HTML sink
//     (defense in depth, even for objects that bypass migrateBook).
//  3. Third-party libs are vendored same-origin (no CDN, no floating tags).
//  4. The service worker precaches the vendored libs.
//  5. The Pages Functions rate limiter allows / blocks / recovers correctly.
//  6. The book_meta ownership migration is present and consistent between
//     schema.sql and supabase/migrations/.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---- 1. migrateBook: trust-boundary sanitization ---- */

const evil = run(`migrateBook({
  id: 'x"><img src=x onerror=alert(1)>',
  title: 'Evil', authors: ['Mallory'],
  status: 'tbr"><script>alert(1)</script>'
})`);
ok('xss: hostile id stripped to safe charset', /^[A-Za-z0-9_-]+$/.test(evil.id));
ok('xss: hostile id keeps its benign prefix', evil.id.indexOf('x') === 0);
ok('xss: hostile status reset to tbr', evil.status === 'tbr');

const evilStatus = run(`migrateBook({ id: 'e2', status: 'reading' })`);
ok('xss: legitimate status preserved', evilStatus.status === 'reading');

for (const s of ['tbr', 'reading', 'read', 'dnf']) {
  ok('xss: status ' + s + ' preserved', run(`migrateBook({ id: 's', status: '${s}' }).status`) === s);
}
ok('xss: unknown status becomes tbr', run(`migrateBook({ id: 's', status: 'bogus' }).status`) === 'tbr');
ok('xss: missing status becomes tbr', run(`migrateBook({ id: 's' }).status`) === 'tbr');

const legit = run(`migrateBook({ id: 'bm-123_ABC', status: 'read' })`);
ok('xss: legitimate id untouched', legit.id === 'bm-123_ABC');

const noId = run(`migrateBook({ title: 'No id' })`);
ok('xss: missing id gets a generated uid', typeof noId.id === 'string' && /^b[0-9a-z]+$/.test(noId.id));

/* ---- 2. sink-level escaping (objects that bypass migrateBook) ---- */

const mk = (over) => Object.assign(
  { id: 'x', title: 'T', authors: ['A'], status: 'tbr', cover: '',
    tropes: [], genres: [], myRating: 0, ratings: {}, axes: [],
    favorite: false, progress: 0, pageCount: 0 }, over);

const rawCard = run(`bookCard(${JSON.stringify(mk({
  id: 'q"><svg onload=alert(1)>', status: 'tbr"x onmouseover=alert(1)'
}))}, 0)`);
ok('xss: bookCard data-id attribute cannot be broken out of',
  !rawCard.includes('data-id="q">') && rawCard.includes('data-id="q&quot;&gt;&lt;svg'));
ok('xss: bookCard status class cannot be broken out of',
  !rawCard.includes('status-tbr"') && rawCard.includes('status-tbr&quot;x'));

const rawTile = run(`bookTile(${JSON.stringify(mk({ id: 'q" autofocus onfocus=alert(1)' }))}, 0)`);
ok('xss: bookTile data-id escaped',
  !rawTile.includes('data-id="q"') && rawTile.includes('data-id="q&quot;'));

/* ---- 3. vendored third-party libs (no CDN) ---- */

const syncJs = read('js/090-sync.js');
const addJs = read('js/130-add.js');
ok('vendor: supabase lib is same-origin', /SB_LIB_URL = 'js\/vendor\/supabase\.min\.js'/.test(syncJs));
ok('vendor: supabase lib has no CDN url', !/cdn\.jsdelivr\.net|unpkg\.com/.test(syncJs));
ok('vendor: quagga is same-origin', /s\.src = 'js\/vendor\/quagga\.min\.js'/.test(addJs));
ok('vendor: quagga has no CDN url', !/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(addJs));
ok('vendor: supabase file exists', fs.existsSync(path.join(ROOT, 'js/vendor/supabase.min.js')));
ok('vendor: quagga file exists', fs.existsSync(path.join(ROOT, 'js/vendor/quagga.min.js')));
ok('vendor: supabase exposes createClient',
  /createClient/.test(read('js/vendor/supabase.min.js').slice(0, 4000) +
    read('js/vendor/supabase.min.js').slice(-4000)));
ok('vendor: quagga build looks like quagga 0.12.1',
  read('js/vendor/quagga.min.js').length > 50000);
ok('vendor: sources documented', /supabase-js@2\.117\.2/.test(read('js/vendor/SOURCES.txt')));

/* ---- 4. service worker precaches the vendor libs ---- */

const sw = read('sw.js');
ok('sw: vendor precache list present', /VENDOR = \['supabase\.min\.js', 'quagga\.min\.js'\]/.test(sw));
ok('sw: vendor files in ASSETS', /\.concat\(JS, VENDOR, AVATARS/.test(sw));

/* ---- 5. Pages Functions rate limiter ---- */

(async () => {
  const { rateLimit } = await import(path.join(ROOT, 'functions/_lib/rate-limit.js'));
  const req = (ip) => ({ headers: { get: (h) => h === 'cf-connecting-ip' ? ip : null } });

  let blocked = 0;
  for (let i = 0; i < 3; i++) {
    if (rateLimit(req('10.0.0.1'), 'test-ep', 3, 60000)) blocked++;
  }
  ok('ratelimit: under the limit passes', blocked === 0);
  const over = rateLimit(req('10.0.0.1'), 'test-ep', 3, 60000);
  ok('ratelimit: over the limit returns 429', over && over.status === 429);
  ok('ratelimit: 429 carries Retry-After', over && over.headers.get('Retry-After') !== null);
  ok('ratelimit: other IP unaffected', rateLimit(req('10.0.0.2'), 'test-ep', 3, 60000) === null);
  ok('ratelimit: other endpoint unaffected', rateLimit(req('10.0.0.1'), 'other-ep', 3, 60000) === null);

  // short window: recovers after expiry
  for (let i = 0; i < 2; i++) rateLimit(req('10.0.0.3'), 'fast-ep', 2, 40);
  ok('ratelimit: short window blocks at limit',
    rateLimit(req('10.0.0.3'), 'fast-ep', 2, 40).status === 429);
  await new Promise((r) => setTimeout(r, 60));
  ok('ratelimit: window expiry recovers', rateLimit(req('10.0.0.3'), 'fast-ep', 2, 40) === null);

  // each wired function actually calls the limiter
  for (const [f, name] of [
    ['functions/api/trope-infer.js', 'trope-infer'],
    ['functions/api/hardcover.js', 'hardcover'],
    ['functions/api/gbooks/[[path]].js', 'gbooks'],
    ['functions/api/trope-models.js', 'trope-models'],
    ['functions/cover-proxy.js', 'cover-proxy'],
  ]) {
    const src = read(f);
    ok('ratelimit: ' + name + ' wired', src.includes(`rateLimit(request, '${name}'`) ||
      src.includes(`rateLimit(context.request, '${name}'`));
  }

  /* ---- 6. book_meta ownership migration ---- */

  const schema = read('supabase/schema.sql');
  const mig = read('supabase/migrations/v194_book_meta_ownership.sql');
  ok('meta: schema has created_by/updated_by', /created_by uuid/.test(schema) && /updated_by uuid/.test(schema));
  ok('meta: refresh policy gated on ownership/staleness',
    /created_by = auth\.uid\(\)/.test(schema) && /interval '30 days'/.test(schema));
  ok('meta: guard trigger in schema', /book_meta_guard_trg/.test(schema));
  ok('meta: migration mirrors schema policy', /created_by = auth\.uid\(\)/.test(mig));
  ok('meta: migration has the guard trigger', /book_meta_guard_trg/.test(mig));
  ok('meta: trigger blocks ownership spoofing', /NEW\.created_by := coalesce\(OLD\.created_by, auth\.uid\(\)\)/.test(mig));

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR - ' + (e && e.message)); process.exit(1); });
