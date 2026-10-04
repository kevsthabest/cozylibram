// Shelf tab (v250): SlowRead-style 2.5D bookshelf — spine spec derivation,
// group filtering, order merging, row chunking, spine crop math, order
// persistence, render smoke test, and photo-spine rendering.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in shelf tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));

/* ---- 1. shelfHash: stable, spread ---- */
const h1 = run(`shelfHash('abc-123')`), h2 = run(`shelfHash('abc-123')`), h3 = run(`shelfHash('xyz-999')`);
ok('shelfHash is deterministic', h1 === h2);
ok('shelfHash spreads different inputs', h1 !== h3);
ok('shelfHash returns uint32', Number.isInteger(h1) && h1 >= 0 && h1 <= 4294967295);

/* ---- 2. shelfSpineSpec: deterministic, in range ---- */
const specA = run(`JSON.stringify(shelfSpineSpec({id:'b1',title:'Fourth Wing'}))`);
const specB = run(`JSON.stringify(shelfSpineSpec({id:'b1',title:'Fourth Wing'}))`);
ok('shelfSpineSpec deterministic', specA === specB);
const spec = run(`shelfSpineSpec({id:'b1'})`);
ok('spine width in range', spec.w >= 30 && spec.w <= 44);
ok('spine height in range', spec.h >= 172 && spec.h <= 215);
ok('spine colors are hex pairs', /^#[0-9a-f]{6}$/i.test(spec.c1) && /^#[0-9a-f]{6}$/i.test(spec.c2));
const palettes = run(`['a','b','c','d','e','f','g','h'].map(id => shelfSpineSpec({id}).c1)`);
ok('palette spreads across books', new Set(palettes).size > 1);

/* ---- 3. shelfGroupBooks ---- */
run(`var __books = [
  {id:'1', title:'A', status:'tbr'},
  {id:'2', title:'B', status:'reading'},
  {id:'3', title:'C', status:'read'},
  {id:'4', title:'D', status:'dnf'},
  {id:'5', title:'E'},
];`);
ok('tbr group', run(`shelfGroupBooks(__books,'tbr').map(b=>b.id).join(',')`) === '1,5');
ok('reading group', run(`shelfGroupBooks(__books,'reading').map(b=>b.id).join(',')`) === '2');
ok('read group', run(`shelfGroupBooks(__books,'read').map(b=>b.id).join(',')`) === '3');
ok('missing status defaults to tbr', run(`shelfGroupBooks([{}],'tbr').length`) === 1);

/* ---- 4. shelfApplyOrder ---- */
run(`var __ordered = shelfApplyOrder(
  [{id:'a'},{id:'b'},{id:'c'}],
  ['c','a','zzz'] // zzz is a dead id
);`);
ok('saved order respected, dead ids dropped, new appended',
  run(`__ordered.map(b=>b.id).join(',')`) === 'c,a,b');
ok('empty order keeps library order',
  run(`shelfApplyOrder([{id:'a'},{id:'b'}], []).map(b=>b.id).join(',')`) === 'a,b');

/* ---- 5. shelfChunk ---- */
ok('chunk splits rows', run(`JSON.stringify(shelfChunk([1,2,3,4,5],2))`) === '[[1,2],[3,4],[5]]');
ok('chunk empty', run(`shelfChunk([],8).length`) === 0);

/* ---- 6. spineCropRect: 1:5.2 center crop ---- */
// Landscape photo (1200x800): height-constrained -> full-height narrow strip.
const rect = run(`spineCropRect(1200, 800)`);
ok('landscape crop keeps full height', rect.h === 800);
ok('landscape crop aspect ~1:5.2', Math.abs(rect.h / rect.w - 5.2) < 0.02);
ok('landscape crop centered horizontally',
  rect.x === Math.round((1200 - rect.w) / 2) && rect.y === 0);
// Tall narrow photo (400x3000, ~1:7.5): width-constrained -> full-width strip.
const rect2 = run(`spineCropRect(400, 3000)`);
ok('tall photo crop keeps full width', rect2.w === 400);
ok('tall photo crop aspect ~1:5.2', Math.abs(rect2.h / rect2.w - 5.2) < 0.02);
ok('tall photo crop centered vertically',
  rect2.y === Math.round((3000 - rect2.h) / 2) && rect2.x === 0);

/* ---- 7. order persistence round-trips through localStorage ---- */
run(`shelfGroup = 'tbr'; shelfCommitOrder(['x','y']);`);
const stored = JSON.parse(window.localStorage.getItem('spicyshelves.shelforder.v1'));
ok('shelfCommitOrder persists per-group order', stored && stored.tbr.join(',') === 'x,y');
run(`shelfOrderCache = null;`);
ok('shelfOrder reloads from storage', run(`shelfOrder().tbr.join(',')`) === 'x,y');
window.localStorage.removeItem('spicyshelves.shelforder.v1');

/* ---- 8. renderShelf smoke test ---- */
run(`library = [
  {id:'b1', title:'Fourth Wing', authors:['Rebecca Yarros'], status:'tbr'},
  {id:'b2', title:'Iron Flame', authors:['Rebecca Yarros'], status:'reading'},
  {id:'b3', title:'ACOTAR', authors:['Sarah J. Maas'], status:'read'},
  {id:'b4', title:'The Ritual', authors:['Shantel Tessier'], status:'tbr', spinePhoto:'data:image/jpeg;base64,AAA'},
];
shelfGroup = 'tbr'; shelfOrderCache = {}; renderShelf();`);
ok('tbr shelf shows 2 spines', qa('#svShelves .spine').length === 2);
ok('chips show counts', q('.sv-chip[data-g="tbr"] .n').textContent === '2');
ok('shelf boards rendered', qa('#svShelves .sv-board').length >= 1);
ok('plant decor on first row', qa('#svShelves .sv-plant').length === 1);
run(`shelfGroup = 'reading'; renderShelf();`);
ok('reading shelf shows 1 spine', qa('#svShelves .spine').length === 1);
ok('empty group shows empty state', (run(`shelfGroup='read'; renderShelf();`), qa('#svShelves .spine').length === 1));
run(`library = []; shelfGroup='tbr'; renderShelf();`);
ok('empty library shows empty state', !!q('.sv-empty') && !!q('#svEmptyAdd'));

/* ---- 9. photo spine renders with .photo class ---- */
run(`library = [{id:'p1', title:'Credence', status:'tbr', spinePhoto:'data:image/jpeg;base64,AAA'}];
shelfGroup='tbr'; shelfOrderCache={}; renderShelf();`);
ok('photo spine has .photo class', qa('#svShelves .spine.photo').length === 1);
ok('photo spine has camera badge', qa('#svShelves .phototag').length === 1);
ok('photo spine hides generated title text', qa('#svShelves .spine.photo .sp-t').length === 0);

/* ---- 10. nav wiring ---- */
ok('Shelf nav button exists', !!q('.bottom-nav button[data-nav="shelf"]'));
ok('navTab maps shelf to itself', run(`navTab('shelf')`) === 'shelf');
ok('render() dispatches shelf view', run(`view='shelf'; render();`) === undefined && !!q('.shelfview'));
ok('shelf icon registered',
  run(`icon('shelf').indexOf('<svg') === 0 && icon('shelf').indexOf('M5 12.5h14') !== -1`));

/* ---- 11. regression: every js/*.js file is wired into index.html ----
   (v250 shipped 205-shelfview.js without its <script> tag — tapping Shelf
   threw ReferenceError and did nothing. The test harness loads files from
   disk, so only this check catches it.) */
const jsFiles = fs.readdirSync(ROOT + '/js').filter(f => f.endsWith('.js'));
const missing = jsFiles.filter(f => html.indexOf('src="js/' + f + '"') === -1);
ok('all js files have a <script> tag in index.html',
  missing.length === 0 ? true : (console.log('missing:', missing.join(',')), false));

/* ---- 12. poses (v252) ---- */
ok('shelfPoseOf defaults to up', run(`shelfPoseOf({})`) === 'up' && run(`shelfPoseOf()`) === 'up');
ok('shelfPoseOf reads down/face',
  run(`shelfPoseOf({shelfPose:'down'})`) === 'down' && run(`shelfPoseOf({shelfPose:'face'})`) === 'face');
ok('shelfPoseOf rejects junk', run(`shelfPoseOf({shelfPose:'sideways'})`) === 'up');

/* ---- 13. shelfLayoutItems: stacks, faces, singles ---- */
run(`var __items = shelfLayoutItems([
  {id:'a', shelfPose:'down'}, {id:'b', shelfPose:'down'}, {id:'c'},
  {id:'d', shelfPose:'face'}, {id:'e', shelfPose:'down'},
]);`);
ok('consecutive downs form one stack',
  run(`__items.length`) === 4 && run(`__items[0].kind`) === 'stack' &&
  run(`__items[0].books.map(b=>b.id).join(',')`) === 'a,b');
ok('upright and face are single items',
  run(`__items[1].kind`) === 'spine' && run(`__items[2].kind`) === 'face');
ok('stack caps at 4 books',
  run(`shelfLayoutItems([1,2,3,4,5].map(i=>({id:'x'+i, shelfPose:'down'}))).map(i=>i.kind+':'+i.books.length).join('|')`) === 'stack:4|stack:1');

/* ---- 14. shelfFillRows: greedy by budget ---- */
ok('greedy row fill',
  run(`JSON.stringify(shelfFillRows([{w:100},{w:100},{w:100}], 250).map(r=>r.length))`) === '[2,1]');
ok('oversize item still gets a row', run(`shelfFillRows([{w:500}], 250).length`) === 1);
ok('empty items', run(`shelfFillRows([], 250).length`) === 0);

/* ---- 15. decor instances (v254: movable, placed by book-index slot) ---- */
run(`shelfOrderCache = null; localStorage.removeItem('spicyshelves.shelforder.v1');`);
ok('decor defaults to plant+candle at end', (() => {
  const d = run(`shelfDecorItems('tbr')`);
  return d.length === 2 && d[0].d === 'plant' && d[1].d === 'candle';
})());
run(`shelfDecorAdd('tbr', 'mug', 4);`);
ok('decor add appends at end slot', (() => {
  const d = run(`shelfDecorItems('tbr')`);
  return d.length === 3 && d[2].d === 'mug' && d[2].at === 4;
})());
run(`shelfDecorAdd('tbr', 'mug', 4); shelfDecorAdd('tbr', 'mug', 4); shelfDecorAdd('tbr', 'mug', 4);`);
ok('decor caps at 3 per kind', run(`shelfDecorItems('tbr').filter(x=>x.d==='mug').length`) === 3);
run(`shelfDecorMove('tbr', 0, 2);`);
ok('decor move sets slot', run(`shelfDecorItems('tbr')[0].at`) === 2);
run(`shelfDecorRemove('tbr', 0);`);
ok('decor remove drops the instance', run(`shelfDecorItems('tbr')[0].d`) === 'candle');
ok('legacy string arrays migrate', (run(`shelfOrderCache={decor:{tbr:['lights']}}`),
  run(`shelfDecorItems('tbr')`)[0].d === 'lights'));
ok('unknown decor ids filtered', (run(`shelfOrderCache={decor:{tbr:[{d:'nope',at:0}]}}`),
  run(`shelfDecorItems('tbr').length`) === 0));
run(`localStorage.removeItem('spicyshelves.shelforder.v1'); shelfOrderCache = null;`);

/* ---- 15b. shelfMergeDecor: pure slot merge ---- */
ok('merge inserts at book-index slots', run(`JSON.stringify(shelfMergeDecor(
  [{kind:'spine'},{kind:'spine'},{kind:'spine'}],
  [{d:'plant', at:0}, {d:'candle', at:2}]
).map(i=>i.kind+':'+(i.decorId||'')))`) === JSON.stringify(['decor:plant','spine:','spine:','decor:candle','spine:']));
ok('merge clamps huge slots to end', run(`shelfMergeDecor(
  [{kind:'spine'}], [{d:'plant', at:999}]
)[1].kind`) === 'decor');
ok('merge skips unknown decor', run(`shelfMergeDecor(
  [{kind:'spine'}], [{d:'nope', at:0}]
).length`) === 1);

/* ---- 16. render smoke: poses + decor button ---- */
run(`library = [
  {id:'f1', title:'Face Book', status:'tbr', shelfPose:'face', cover:'https://x/y.jpg'},
  {id:'f2', title:'Flat One', status:'tbr', shelfPose:'down'},
  {id:'f3', title:'Flat Two', status:'tbr', shelfPose:'down'},
  {id:'f4', title:'Up Book', status:'tbr'},
];
shelfGroup='tbr'; shelfOrderCache={}; renderShelf();`);
ok('face-out renders', qa('#svShelves .faceout').length === 1);
ok('face-out shows the cover', !!q('#svShelves .faceout img'));
ok('laid-down pair forms one stack', qa('#svShelves .hstack').length === 1);
ok('stack carries both book ids', q('#svShelves .hstack').dataset.ids === 'f2,f3');
ok('decor button in header', !!q('#svDecor'));
ok('long-press sheet offers three poses', (run(`shelfOpenPhotoSheet('f4')`),
  qa('#svSheet [data-pose]').length === 3));

/* ---- 19. v254 render: 3D bits + draggable decor ---- */
run(`shelfCloseSheet(); library = [{id:'g1', title:'Up Book', status:'tbr'}];
shelfGroup='tbr'; shelfOrderCache={}; renderShelf();`);
ok('spine carries page-block sliver', qa('#svShelves .spine .sp-pages').length === 1);
ok('spine has deterministic tilt', /rotate\(-?[\d.]+deg\)/.test(q('#svShelves .spine').style.transform));
ok('decor renders as draggable item', qa('#svShelves .sv-dragdecor').length === 2);
ok('dragdecor exposes decor id', q('#svShelves .sv-dragdecor').dataset.decor === 'plant');
run(`library = [];`);

/* ---- 20. v255 seasons ---- */
ok('october defaults to halloween', run(`shelfDefaultSeason(new Date(2026, 9, 15))`) === 'halloween');
ok('december defaults to christmas', run(`shelfDefaultSeason(new Date(2026, 11, 25))`) === 'christmas');
ok('june defaults to none', run(`shelfDefaultSeason(new Date(2026, 5, 1))`) === 'none');
run(`shelfOrderCache = null; localStorage.removeItem('spicyshelves.shelforder.v1');`);
ok('season auto-detects until overridden', run(`shelfSeason()`).length > 0);
run(`shelfSetSeason('halloween');`);
ok('season persists', run(`shelfOrder().season`) === 'halloween');
ok('tray offers halloween set, not christmas', (() => {
  const t = run(`shelfTrayDecor()`);
  return t.indexOf('pumpkin') !== -1 && t.indexOf('ghost') !== -1 && t.indexOf('tree') === -1;
})());
run(`shelfSetSeason('christmas');`);
ok('tray offers christmas set, not halloween', (() => {
  const t = run(`shelfTrayDecor()`);
  return t.indexOf('tree') !== -1 && t.indexOf('snowman') !== -1 && t.indexOf('pumpkin') === -1;
})());
run(`shelfSetSeason('none');`);
ok('tray hides seasonal decor when none', (() => {
  const t = run(`shelfTrayDecor()`);
  return t.indexOf('pumpkin') === -1 && t.indexOf('tree') === -1 && t.indexOf('plant') !== -1;
})());
run(`shelfSetSeason('nope');`);
ok('invalid season ignored', run(`shelfSeason()`) === 'none');
run(`shelfSetSeason('halloween');
library = [{id:'h1', title:'Spooky Book', status:'tbr'}];
shelfGroup='tbr'; shelfOrderCache=null; renderShelf();`);
ok('shelf carries season class', q('#svShelves').className.indexOf('season-halloween') !== -1);
ok('season fx floats', qa('#svShelves .sv-fx span').length === 3);
run(`shelfOpenDecorSheet();`);
ok('tray shows season chips', qa('#svSeasonRow [data-s]').length === 8);
run(`shelfCloseSheet(); library = []; shelfOrderCache=null;
localStorage.removeItem('spicyshelves.shelforder.v1');`);

/* ---- 21. v256 more holidays ---- */
const eas = d => { const e = run(`shelfEasterSunday(${d})`); return e.getFullYear() + '-' + (e.getMonth() + 1) + '-' + e.getDate(); };
ok('easter 2026 = apr 5', eas(2026) === '2026-4-5');
ok('easter 2027 = mar 28', eas(2027) === '2027-3-28');
ok('easter 2025 = apr 20', eas(2025) === '2025-4-20');
const thx = d => { const t = run(`shelfCanadianThanksgiving(${d})`); return t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate(); };
ok('thanksgiving 2026 = oct 12', thx(2026) === '2026-10-12');
ok('thanksgiving 2027 = oct 11', thx(2027) === '2027-10-11');
const ds = (y, m, d) => run(`shelfDefaultSeason(new Date(${y}, ${m}, ${d}))`);
ok('jan 3 -> new year', ds(2027, 0, 3) === 'newyear');
ok('dec 30 -> new year', ds(2026, 11, 30) === 'newyear');
ok('feb 10 -> valentine', ds(2027, 1, 10) === 'valentine');
ok('mar 15 -> st patrick', ds(2027, 2, 15) === 'stpatrick');
ok('easter week -> easter', ds(2027, 2, 25) === 'easter');
ok('easter sunday -> easter', ds(2027, 2, 28) === 'easter');
ok('oct 8 2026 -> thanksgiving', ds(2026, 9, 8) === 'thanksgiving');
ok('oct 20 -> halloween', ds(2026, 9, 20) === 'halloween');
ok('dec 15 -> christmas', ds(2026, 11, 15) === 'christmas');
ok('jun 1 -> none', ds(2026, 5, 1) === 'none');
run(`shelfSetSeason('newyear');`);
ok('tray offers new year set', (() => {
  const t = run(`shelfTrayDecor()`);
  return t.indexOf('fireworks') !== -1 && t.indexOf('champagne') !== -1 && t.indexOf('bunny') === -1;
})());
run(`shelfSetSeason('easter');`);
ok('tray offers easter set', run(`shelfTrayDecor()`).indexOf('bunny') !== -1);
run(`shelfSetSeason('newyear');
library = [{id:'n1', title:'Fresh Start', status:'tbr'}];
shelfGroup='tbr'; shelfOrderCache=null; renderShelf();`);
ok('new year shelf class', q('#svShelves').className.indexOf('season-newyear') !== -1);
ok('new year fx floats', qa('#svShelves .sv-fx span').length === 3);
run(`library = []; shelfOrderCache=null;
localStorage.removeItem('spicyshelves.shelforder.v1');`);

/* ---- 17. spineBoxCropRect (v253): 0-1000 x-range -> pixel rect ---- */
const br = run(`spineBoxCropRect(1000, 800, 100, 200)`);
ok('box maps to pixel strip', br.x === 100 && br.w > 0);
ok('box crop keeps spine aspect', Math.abs(br.h / br.w - 5.2) < 0.05);
ok('box crop vertically centered', br.y === Math.round((800 - br.h) / 2));
ok('box clamped inside the image', (() => {
  const r = run(`spineBoxCropRect(1000, 800, -50, 1200)`);
  return r.x >= 0 && r.x + r.w <= 1000 && r.y >= 0 && r.y + r.h <= 800;
})());
ok('sliver box -> null', run(`spineBoxCropRect(1000, 800, 500, 503)`) === null);
ok('inverted box -> null', run(`spineBoxCropRect(1000, 800, 700, 600)`) === null);
ok('missing box -> null', run(`spineBoxCropRect(1000, 800, null, 200)`) === null);
ok('non-numeric box -> null', run(`spineBoxCropRect(1000, 800, "l", "r")`) === null);

/* ---- 18. shelfScanSpinePhoto null paths (v253) ---- */
(async () => {
  const n1 = await run(`shelfScanSpinePhoto(null)`);
  ok('no entry -> null', n1 === null);
  const n2 = await run(`shelfScanSpinePhoto({spine:{title:'X', x0:100, x1:200}})`);
  ok('no scan photo -> null', n2 === null);
  run(`shelfScanPhoto = 'data:image/jpeg;base64,AAA';`);
  const n3 = await run(`shelfScanSpinePhoto({spine:{title:'X'}})`);
  ok('no box coords -> null', n3 === null);
  run(`shelfScanPhoto = null;`);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
