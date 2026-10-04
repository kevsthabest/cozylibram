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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
