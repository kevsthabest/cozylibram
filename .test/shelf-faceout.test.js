// shelf-faceout: 3D shelf face-out display picks (Variant A, User-picked).
// The reader marks a book "display face-out"; on the 3D shelf it renders in
// its place in the run with its cover on the front face. Unpicked shelves
// must render EXACTLY as before — the packer goldens below were captured
// from the pre-change code and pin that. The THREE scene itself is not
// executed (jsdom has no WebGL — same seam as shelf3d-integration); the
// engine's decision logic lives in pure helpers (js/204) + the shared
// packer, which ARE executed here, plus source pins on js/215's wiring.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in tests'); };
window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };
window.__sbStub = { auth: { getSession: async () => ({ data: { session: null } }) } };
require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const placed = (r) => r.placed.map(p => [p.i, p.li, r6(p.x), r6(p.w), p.h]);
const tick = (n) => new Promise(r => { let i = 0; const s = () => (++i >= (n || 3) ? r() : setTimeout(s, 20)); s(); });

(async () => {

/* ---- 1. pure helpers (js/204) ---- */
ok('face width helper exists', run(`typeof shelf3dFaceWidth`) === 'function');
ok('face width scales with height', Math.abs(run(`shelf3dFaceWidth(2.0)`) - 1.36) < 1e-9);
ok('face width clamps low', run(`shelf3dFaceWidth(1.0)`) === 0.95);
ok('face width clamps high', run(`shelf3dFaceWidth(2.6)`) === 1.6);
ok('face width tolerates junk', run(`shelf3dFaceWidth('x')`) > 0.9 && run(`shelf3dFaceWidth('x')`) < 1.7);
ok('face depth helper clamps like the spine clamp',
  run(`shelf3dFaceDepth(0.5)`) === 0.5 && run(`shelf3dFaceDepth(9)`) === 0.72 &&
  run(`shelf3dFaceDepth(0)`) === 0.3 && run(`shelf3dFaceDepth('x')`) === 0.44);
ok('face z: front sits just behind the spine fronts',
  Math.abs(run(`shelf3dFaceZ(0.44)`) - (0.875 - 0.06 - 0.22)) < 1e-9);
{
  const wide = JSON.parse(run(`JSON.stringify(shelf3dCoverCrop(1000, 500, 0.65))`));
  ok('crop: wide image crops x, centred',
    Math.abs(wide.rx - 0.325) < 1e-9 && wide.ry === 1 && Math.abs(wide.ox - 0.3375) < 1e-9 && wide.oy === 0);
  const tall = JSON.parse(run(`JSON.stringify(shelf3dCoverCrop(500, 1000, 0.65))`));
  ok('crop: tall image crops y, centred',
    tall.rx === 1 && Math.abs(tall.ry - (0.5 / 0.65)) < 1e-9 && tall.ox === 0 && Math.abs(tall.oy - (1 - 0.5 / 0.65) / 2) < 1e-9);
  const exact = JSON.parse(run(`JSON.stringify(shelf3dCoverCrop(650, 1000, 0.65))`));
  ok('crop: matching aspect is a no-op', exact.rx === 1 && exact.ry === 1 && exact.ox === 0 && exact.oy === 0);
  const junk = JSON.parse(run(`JSON.stringify(shelf3dCoverCrop(0, 0, 0.65))`));
  ok('crop: degenerate image stays finite', isFinite(junk.rx) && isFinite(junk.ry) && junk.rx > 0 && junk.ry > 0);
}

/* ---- 2. spec mapping (js/217 shelfBooks3D) ---- */
{
  const spec = JSON.parse(run(`JSON.stringify(shelfBooks3D([{id:'g1',title:'Dune',cover:'c.jpg',authors:['Frank Herbert']}])[0])`));
  ok('unpicked: legacy spec fields unchanged',
    spec.spineC1 === '#3a3a4d' && spec.spineC2 === '#1e1e28' &&
    spec.spineW === 0.6285714285714286 && spec.spineH === 1.8);
  ok('unpicked: faceOut is false', spec.faceOut === false);
  ok('spec carries the cover url', spec.cover === 'c.jpg');
  ok('spec carries the author (placeholder byline)', spec.author === 'Frank Herbert');
  const pk = JSON.parse(run(`JSON.stringify(shelfBooks3D([{id:'g1',title:'Dune',cover:'c.jpg',faceOut:true}])[0])`));
  ok('picked: faceOut true', pk.faceOut === true);
  ok('picked: faceW derived from height', Math.abs(pk.faceW - run(`shelf3dFaceWidth(1.8)`)) < 1e-9 && pk.faceW > pk.spineW);
  const noc = JSON.parse(run(`JSON.stringify(shelfBooks3D([{id:'g2',title:'NoCover',faceOut:true}])[0])`));
  ok('picked without a cover: faceOut true, cover empty (placeholder path)', noc.faceOut === true && noc.cover === '');
}

/* ---- 3. the shared packer ---- */
const SPINES = [
  { spineW: 0.4, spineH: 2.0 }, { spineW: 0.5, spineH: 1.8 }, { spineW: 0.6, spineH: 2.2 },
  { spineW: 0.35, spineH: 1.6 }, { spineW: 0.44, spineH: 2.0 }
];
const GOLD_BASE = [[0, 2, -4.65, 0.4, 2], [1, 2, -4.225, 0.5, 1.8], [2, 2, -3.7, 0.6, 2.2], [3, 2, -3.075, 0.35, 1.6], [4, 2, -2.7, 0.44, 2]];
const GOLD_OBS = [[0, 2, -2.975, 0.4, 2], [1, 2, -2.55, 0.5, 1.8], [2, 2, -2.025, 0.6, 2.2], [3, 2, -1.4, 0.35, 1.6], [4, 2, -1.025, 0.44, 2]];
{
  const base = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(SPINES)}, {}, 60))`));
  ok('GOLDEN: unpicked pack is byte-identical to pre-change', JSON.stringify(placed(base)) === JSON.stringify(GOLD_BASE) && base.overflow.length === 0);
  const obs = { 2: [[-4.65, -3.0]], 1: [], 0: [] };
  const withObs = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(SPINES)}, ${JSON.stringify(obs)}, 60))`));
  ok('GOLDEN: unpicked pack around a decoration is byte-identical', JSON.stringify(placed(withObs)) === JSON.stringify(GOLD_OBS));
  const explicitFalse = SPINES.map(b => Object.assign({ faceOut: false, faceW: 1.3 }, b));
  const ef = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(explicitFalse)}, {}, 60))`));
  ok('faceOut:false behaves exactly like no flag', JSON.stringify(placed(ef)) === JSON.stringify(GOLD_BASE));
}
{
  const mid = SPINES.map((b, i) => i === 1 ? Object.assign({}, b, { faceOut: true, faceW: 1.3 }) : b);
  const r = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(mid)}, {}, 60))`));
  ok('pick renders at cover width, neighbours reflow',
    JSON.stringify(placed(r)) === JSON.stringify([[0, 2, -4.65, 0.4, 2], [1, 2, -4.225, 1.3, 1.8], [2, 2, -2.9, 0.6, 2.2], [3, 2, -2.275, 0.35, 1.6], [4, 2, -1.9, 0.44, 2]]));
  const adj = [
    { spineW: 0.4, spineH: 2.0, faceOut: true, faceW: 1.3 },
    { spineW: 0.4, spineH: 2.0, faceOut: true, faceW: 1.2 },
    { spineW: 0.5, spineH: 2.0 }
  ];
  const ra = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(adj)}, {}, 60))`));
  ok('adjacent picks sit side by side at full width, no overlap',
    JSON.stringify(placed(ra)) === JSON.stringify([[0, 2, -4.65, 1.3, 2], [1, 2, -3.325, 1.2, 2], [2, 2, -2.1, 0.5, 2]]));
  const fill = Array.from({ length: 12 }, () => ({ spineW: 0.72, spineH: 2.0 }));
  fill.push({ spineW: 0.4, spineH: 2.0, faceOut: true, faceW: 1.3 });
  const rw = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(fill)}, {}, 60))`));
  const lastP = rw.placed[rw.placed.length - 1];
  ok('a pick that cannot fit the level wraps to the next level', lastP.i === 12 && lastP.li === 1 && r6(lastP.x) === -4.65 && rw.overflow.length === 0);
  const obs = { 2: [[-4.65, -3.0]], 1: [], 0: [] };
  const ro = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify([{ spineW: 0.4, spineH: 2.0, faceOut: true, faceW: 1.3 }])}, ${JSON.stringify(obs)}, 60))`));
  ok('a pick jumps a decoration interval like any book', ro.placed.length === 1 && r6(ro.placed[0].x) === -2.975 && r6(ro.placed[0].w) === 1.3);
  const cap = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(adj)}, {}, 2))`));
  ok('case cap still applies to picks (overflow flows on)', cap.placed.length === 2 && JSON.stringify(cap.overflow) === '[2]');
  const huge = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify([{ spineW: 0.4, spineH: 2.0, faceOut: true, faceW: 99 }])}, {}, 60))`));
  ok('absurd faceW clamps to the face bound', huge.placed.length === 1 && huge.placed[0].w <= 1.75);
}

/* ---- 4. engine wiring (source pins — the scene is device-verified) ---- */
{
  const src = fs.readFileSync(ROOT + '/js/215-shelf3d.js', 'utf8');
  ok('engine has a face-out book maker', src.includes('function makeFaceBook('));
  ok('layout branches on the pick', src.includes('b.faceOut ? makeFaceBook('));
  ok('face cover loads through the shared cover-source order', src.includes('coverColorSources('));
  ok('placeholder texture exists', src.includes('function facePlaceholderTexture('));
  ok('placeholder draws the title', /facePlaceholderTexture[\s\S]{0,2400}b\.title/.test(src));
  ok('mode change rebuilds the mesh', src.includes('sb.mode !== mode'));
  ok('cover change rebuilds the mesh (a later cover shows)', src.includes('sb.coverKey !== coverKey'));
  ok('face mesh keeps the book id (tap opens the book)', /makeFaceBook[\s\S]{0,1600}userData\.bookId = b\.id/.test(src));
  const src204 = fs.readFileSync(ROOT + '/js/204-shelf3d-layout.js', 'utf8');
  ok('packer consults the pick', src204.includes('b.faceOut'));
  const src217 = fs.readFileSync(ROOT + '/js/217-shelf3d-view.js', 'utf8');
  ok('view maps the pick from the book record', src217.includes('faceOut: !!b.faceOut'));
}

/* ---- 4b. the no-pipeline cover fallback's contract (Advisor LOW, PR #237) ----
   When coverColorSources is absent, faceCoverMaterial falls back to a bare
   shape check on the cover URL. That check admits only same-device sources —
   data:, blob:, and same-origin absolute paths. A protocol-relative URL
   (//host/…) starts with a slash but is a cross-origin fetch, so it must be
   rejected; a plain https: URL is also rejected HERE — remote covers are
   coverColorSources' job (CORS-clean ordering), never the fallback's. */
{
  const src = fs.readFileSync(ROOT + '/js/215-shelf3d.js', 'utf8');
  const line = src.split('\n').find(l => l.includes('.test(b.cover)') && l.includes('? [[b.cover, false]]'));
  ok('defensive cover fallback exists (no-pipeline path)', !!line);
  ok('pipeline stays first: coverColorSources is the ternary\u2019s taken branch',
    src.includes('? coverColorSources(b.cover)') &&
    src.indexOf('? coverColorSources(b.cover)') < src.indexOf('.test(b.cover)'));
  const m = line && line.match(/\(\/(\^.*?)\/\.test/);
  const fallback = m ? new RegExp(m[1]) : null;
  ok('fallback regex extracts from source', !!fallback);
  if (fallback) {
    ok('fallback accepts a data: cover', fallback.test('data:image/webp;base64,UklGRg=='));
    ok('fallback accepts a blob: cover', fallback.test('blob:https://cozylibram.pages.dev/9f2c'));
    ok('fallback accepts a same-origin absolute path', fallback.test('/covers/abc.webp'));
    ok('fallback rejects a protocol-relative URL', !fallback.test('//evil.example/x.jpg'));
    ok('fallback rejects a plain https: URL (coverColorSources\u2019 job)', !fallback.test('https://img.example/x.jpg'));
    ok('fallback rejects a plain http: URL too', !fallback.test('http://img.example/x.jpg'));
  }
}

/* ---- 5. sync round-trip: the pick rides the whole-record row ---- */
{
  const row = JSON.parse(run(`JSON.stringify(bookToRow({ id: 's1', title: 'T', faceOut: true }, 'u1'))`));
  ok('bookToRow carries faceOut in data', row.data.faceOut === true && row.book_id === 's1');
  const back = JSON.parse(JSON.stringify(row.data));
  ok('JSON round-trip preserves the pick', back.faceOut === true);
  const plain = JSON.parse(run(`JSON.stringify(bookToRow({ id: 's2', title: 'T' }, 'u1'))`));
  ok('unpicked book gains no field in the row', !('faceOut' in plain.data));
}

/* ---- 6. the modal toggle (real modal, real Save) ---- */
run(`
  library.push({ id: 'fo1', title: 'Plain Book', authors: ['A'], cover: 'plain.jpg',
    status: 'tbr', owned: 'owned', ratings: {}, tropes: [], tropesAuto: [], axes: [],
    log: [], quotes: [], contentWarnings: [], moods: [] });
  library.push({ id: 'fo2', title: 'Picked Book', authors: ['B'], cover: 'picked.jpg', faceOut: true,
    status: 'read', owned: 'owned', ratings: {}, tropes: [], tropesAuto: [], axes: [],
    log: [], quotes: [], contentWarnings: [], moods: [] });
`);
run(`openDetail('fo1')`);
await tick(6);
{
  const cb = window.document.getElementById('f-faceout');
  ok('modal shows the face-out toggle', !!cb);
  ok('unpicked book: toggle starts off', !!cb && cb.checked === false);
  if (cb) { cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true })); }
  window.document.getElementById('m-save').click();
  await tick(4);
  ok('Save persists the pick on the book', run(`library.find(b => b.id === 'fo1').faceOut`) === true);
  ok('Save keeps the cover (no draft clobber)', run(`library.find(b => b.id === 'fo1').cover`) === 'plain.jpg');
}
run(`openDetail('fo2')`);
await tick(6);
{
  const cb = window.document.getElementById('f-faceout');
  ok('picked book: toggle starts on', !!cb && cb.checked === true);
  if (cb) { cb.checked = false; cb.dispatchEvent(new window.Event('change', { bubbles: true })); }
  window.document.getElementById('m-save').click();
  await tick(4);
  ok('unpick persists (faceOut false)', run(`library.find(b => b.id === 'fo2').faceOut`) === false);
}

console.log(`\nshelf-faceout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
