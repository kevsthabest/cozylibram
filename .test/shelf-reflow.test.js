// v514: shelf decoration reflow — books flow around decorations.
// Covers: the shared packer (Shelf3D.packCase), the footprint table
// (Shelf3D.decoFootprint, drift-guarded against the makers' userData.fw),
// dynamic case slicing (shelf3dSliceRoom), case lookup for labels/find
// (shelf3dCaseOf), and removal restoring the baseline layout.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);

/* Deterministic spine widths for every book: spec w 31px -> spineW 31/70. */
run(`shelfSpineSpec = function () { return { c1: '#334455', c2: '#667788', w: 31, h: 190 }; };`);
const W = 31 / 70;   // 0.442857 — 19 books per unobstructed level, 57 per case

/* ---------- 1. the packer ---------- */
{
  const books = (n, w) => Array.from({ length: n }, () => ({ spineW: w, spineH: 2 }));
  // baseline: cap binds at 60, top shelf (level 2) fills first
  const base = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(books(200, 0.3))}, {}, 60))`));
  ok('packer: cap of 60 binds for narrow books', base.placed.length === 60 && base.overflow.length === 140);
  ok('packer: fills the top shelf first', base.placed[0].li === 2);
  // physical capacity at test width: 19/level -> 57/case
  const wide = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(books(200, W))}, {}, 60))`));
  ok('packer: physical capacity 57 at spineW 31/70', wide.placed.length === 57 && wide.overflow.length === 143);

  // (a) a decoration interval on the top level: books land on BOTH sides, none overlap
  const obs = { 2: [[-0.6, 0.6]] };
  const r = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(books(60, W))}, ${JSON.stringify(obs)}, 60))`));
  const top = r.placed.filter(p => p.li === 2);
  ok('packer: no book overlaps the decoration interval',
    top.every(p => p.x + p.w <= -0.6 + 1e-9 || p.x >= 0.6 - 1e-9));
  ok('packer: books sit on both sides of the decoration',
    top.some(p => p.x + p.w <= -0.6 + 1e-9) && top.some(p => p.x >= 0.6 - 1e-9));
  ok('packer: obstructed top level holds 16 (8 + 8)', top.length === 16);
  ok('packer: displaced books flow to lower levels, none lost',
    r.placed.length === 54 && r.overflow.length === 6);

  // (b) a full level + full case: the overflow is exactly the displaced tail
  const full = JSON.parse(run(`JSON.stringify(Shelf3D.packCase(${JSON.stringify(books(57, W))}, ${JSON.stringify(obs)}, 60))`));
  ok('packer: placing on a full case displaces books to overflow',
    full.placed.length === 54 && full.overflow.join() === '54,55,56');
  // edge-draped pieces are not obstacles at all when footprint is 0 — the
  // slicer never emits intervals for them (covered in section 3).

  // empty / junk inputs stay safe
  const none = JSON.parse(run(`JSON.stringify(Shelf3D.packCase([], {}, 60))`));
  ok('packer: empty input packs empty', none.placed.length === 0 && none.overflow.length === 0);
}

/* ---------- 2. footprint table ---------- */
{
  ok('footprint: stack is 1.2', run(`Shelf3D.decoFootprint('stack')`) === 1.2);
  ok('footprint: plant is 0.75', run(`Shelf3D.decoFootprint('plant')`) === 0.75);
  ok('footprint: pack deco dragon-egg is 0.7', run(`Shelf3D.decoFootprint('dragon-egg')`) === 0.7);
  ok('footprint: fairy lights drape (0 — displace nothing)', run(`Shelf3D.decoFootprint('lights')`) === 0);
  ok('footprint: star garland drapes (0)', run(`Shelf3D.decoFootprint('stargarland')`) === 0);
  ok('footprint: room/unknown types are 0', run(`Shelf3D.decoFootprint('pumpkin')`) === 0 && run(`Shelf3D.decoFootprint('nope')`) === 0);

  // Drift guard: the table must mirror every maker's userData.fw in
  // js/215-shelf3d.js (room-mounted and edge-draped types excepted).
  const src215 = fs.readFileSync(ROOT + '/js/215-shelf3d.js', 'utf8');
  const roomTypes = { web: 1, pumpkin: 1, moon: 1, snowflake: 1 };
  const edgeTypes = { lights: 1, stargarland: 1 };
  const makerRe = /decoType: '([a-z-]+)', fw: ([0-9.]+)/g;
  let m, checked = 0, drift = [];
  while ((m = makerRe.exec(src215))) {
    const type = m[1], fw = parseFloat(m[2]);
    if (roomTypes[type]) continue;
    checked++;
    const table = run(`Shelf3D.decoFootprint(${JSON.stringify(type)})`);
    if (edgeTypes[type]) { if (table !== 0) drift.push(type + ' (edge, table ' + table + ')'); }
    else if (table !== fw) drift.push(type + ' (maker ' + fw + ', table ' + table + ')');
  }
  ok('footprint table mirrors all ' + checked + ' shelf makers (drift: ' + drift.join('; ') + ')',
    checked >= 29 && drift.length === 0);
}

/* ---------- 3. dynamic slicing ---------- */
const BOOKS200 = Array.from({ length: 200 }, (_, i) => ({ id: 'bk' + i, title: 'Book ' + i }));
const setDecoDoc = (cases) => run(`localStorage.setItem('cozylibram.s3d.deco.v2', ${JSON.stringify(JSON.stringify({ v: 2, cases }))})`);
const clearDecoDoc = () => run(`localStorage.removeItem('cozylibram.s3d.deco.v2')`);
const sliceLens = (books, group) => JSON.parse(run(`JSON.stringify(shelf3dSliceRoom(${JSON.stringify(books)}, ${JSON.stringify(group)}).map(c => c.length))`));

{
  clearDecoDoc();
  ok('slicing: no decor -> physical cases 57/57/57/29', sliceLens(BOOKS200, 'read').join() === '57,57,57,29');

  // (c) a book stack anchored mid top-shelf of case 1 shifts the boundaries
  setDecoDoc({ 'read:0': [{ type: 'stack', pi: 2, x: 0, room: false }] });
  ok('slicing: decor on case 1 shifts boundaries to 54/57/57/32',
    sliceLens(BOOKS200, 'read').join() === '54,57,57,32');

  // decor on another group must not affect this room
  ok('slicing: decor is per-group', sliceLens(BOOKS200, 'tbr').join() === '57,57,57,29');

  // room decorations never displace books
  setDecoDoc({ 'read:0': [{ type: 'pumpkin', pi: 0, x: 0, room: true }, { type: 'stack', pi: 2, x: 0, room: false }] });
  ok('slicing: room decor ignored, shelf decor counts', sliceLens(BOOKS200, 'read').join() === '54,57,57,32');

  // fairy lights drape in front of the books: no displacement
  setDecoDoc({ 'read:0': [{ type: 'lights', pi: 2, x: 0, room: false }] });
  ok('slicing: fairy lights displace nothing', sliceLens(BOOKS200, 'read').join() === '57,57,57,29');

  // (c) a decor-only trailing case still exists in the case list
  const ten = BOOKS200.slice(0, 10);
  setDecoDoc({ 'read:2': [{ type: 'plant', pi: 1, x: -2, room: false }] });
  const tc = JSON.parse(run(`JSON.stringify(shelf3dSliceRoom(${JSON.stringify(ten)}, 'read').map(c => c.length))`));
  ok('slicing: decor-only trailing case present', tc.join() === '10,0,0');

  // (e) removing the decoration restores the baseline layout
  clearDecoDoc();
  ok('slicing: decor removed -> baseline restored', sliceLens(BOOKS200, 'read').join() === '57,57,57,29');
  setDecoDoc({ 'read:0': [{ type: 'stack', pi: 2, x: 0, room: false }] });
  ok('slicing: decor back -> shifted again', sliceLens(BOOKS200, 'read').join() === '54,57,57,32');
  clearDecoDoc();
  ok('slicing: and removed again -> baseline', sliceLens(BOOKS200, 'read').join() === '57,57,57,29');

  // no books at all: still exactly one (empty) case
  ok('slicing: empty library -> one empty case', sliceLens([], 'read').join() === '0');
}

/* ---------- 4. case lookup (labels + find) ---------- */
{
  setDecoDoc({ 'read:0': [{ type: 'stack', pi: 2, x: 0, room: false }] });
  const room = JSON.parse(run(`(function () {
    var cases = shelf3dSliceRoom(${JSON.stringify(BOOKS200)}, 'read');
    var starts = [], acc = 0;
    cases.forEach(function (c) { starts.push(acc); acc += c.length; });
    return JSON.stringify({ starts: starts });
  })()`));
  const caseOf = (idx) => run(`shelf3dCaseOf({ starts: ${JSON.stringify(room.starts)} }, ${idx})`);
  ok('caseOf: book 53 is the last of case 1', caseOf(53) === 0);
  ok('caseOf: book 54 now opens case 2 (was case 1 at fixed 60s)', caseOf(54) === 1);
  ok('caseOf: book 110 ends case 2', caseOf(110) === 1);
  ok('caseOf: book 111 opens case 3', caseOf(111) === 2);
  ok('caseOf: last book is in case 4', caseOf(199) === 3);
  clearDecoDoc();
}

/* ---------- 5. engine wiring (source-level) ---------- */
{
  const src215 = fs.readFileSync(ROOT + '/js/215-shelf3d.js', 'utf8');
  const src217 = fs.readFileSync(ROOT + '/js/217-shelf3d-view.js', 'utf8');
  ok('engine: setBooks lays out via the shared packer', src215.includes('shelf3dPackCase(currentBooks, bookObstacles(), MAX_BOOKS)'));
  ok('engine: place/remove wrappers reflow the books',
    (src215.match(/if \(!loadingCase\) reflowBooks\(\);/g) || []).length === 2);
  ok('engine: full level claims the drop spot', src215.includes('scanFreeSpot(pi, x, fw,') && src215.includes('claim the drop spot'));
  ok('engine (v523): decorations avoid other decorations, not books',
    src215.includes('a decoration only avoids OTHER decorations') && !/occupied\[pi\]\.slice\(\)\.sort/.test(src215));
  ok('engine (v523): wall/floor pieces land where tapped or dropped',
    src215.includes('function roomSurfaceHit(') && src215.includes('var rh = roomSurfaceHit(item.type, ray);') &&
    src215.includes('var dropAt = r.surf ? r.surf.pos'));
  ok('engine (v523): wall/floor pieces persist (y saved, restored on load, wrapper saves)',
    src215.includes('y: p.group.position.y') && src215.includes('placeRoomDeco(d.type, new THREE.Vector3(d.x, ry, d.z), null, true)') &&
    src215.includes('var _origPlaceRoomDeco = placeRoomDeco;'));
  ok('engine: decorations restore before the initial book layout',
    src215.indexOf('var restored = loadDecoLayout();') < src215.indexOf('if (opts.initialBooks) setBooks(opts.initialBooks);'));
  ok('engine: move-drop settles onto the claimed spot, then persists + reflows',
    src215.includes('(rec3.rec[0] + rec3.rec[1]) / 2') &&
    /saveDecoLayout\(\);\s*\n\s*reflowBooks\(\);/.test(src215));
  ok('view: goCase passes case + next case to the engine', src217.includes('shelf3dCaseBooks(room, i)'));
  ok('view: engine gets the deco-change callback', src217.includes('onDecoChange: shelf3dOnDecoChange'));
  ok('view: find labels use real case boundaries', !src217.includes('Math.floor(h.idx / SHELF3D_MAX_BOOKS)'));
  ok('view: case bar uses cumulative starts', src217.includes('room.starts[i]'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
