// Spine FX tests: cover dominant-color extraction + pull-out animation.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in spinefx tests'); };
if (!window.requestAnimationFrame) window.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// controllable pixels for the fake cover
let fakePixels = null; // Uint8ClampedArray(24*24*4) or 'throw'
window.HTMLCanvasElement.prototype.getContext = () => ({
  drawImage() {},
  getImageData: () => {
    if (fakePixels === 'throw') throw new Error('tainted');
    return { data: fakePixels };
  }
});
window.Image = class { set src(v) { setTimeout(() => this.onload && this.onload(), 0); } };
let reduced = false;
window.matchMedia = () => ({ matches: reduced });

const scriptEl = window.document.createElement('script');
scriptEl.textContent = fs.readFileSync('/home/hatch/workspace/booktok/app.js', 'utf8');
window.document.body.appendChild(scriptEl);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms));
const solid = (r, g, b) => {
  const a = new Uint8ClampedArray(24 * 24 * 4);
  for (let i = 0; i < a.length; i += 4) { a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255; }
  return a;
};
const mk = (id, cover) => `({ id: '${id}', isbn: '', title: 'FX ${id}', authors: ['Jane Doe'], cover: '${cover}',
  description: '', pageCount: 300, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
  status: 'read', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0,
  dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: true })`;

(async () => {
// 1. dominant color of a red cover -> darkened red
fakePixels = solid(200, 30, 30);
ok('dominant color extracted', await window.coverDominantColor('http://x/c.jpg') === '#ab0d0d');

// 2. gray cover -> null (nothing distinctive)
fakePixels = solid(128, 128, 128);
ok('gray cover returns null', await window.coverDominantColor('http://x/c.jpg') === null);

// 3. tainted canvas -> null, no crash
fakePixels = 'throw';
ok('tainted canvas returns null', await window.coverDominantColor('http://x/c.jpg') === null);

// 4. cached color applied to spine without network
fakePixels = solid(200, 30, 30);
runInWindow(`localStorage.clear(); favExpanded = false;
  spineColorCache['fx1'] = { hex: '#123456', cover: 'http://x/a.jpg' };
  library.push(${mk('fx1', 'http://x/a.jpg')});
  library.push(${mk('fx2', 'http://x/b.jpg')});
  renderLibrary();`);
const sp1 = q('.fav-shelf .spine[data-id="fx1"]');
ok('cached color applied', sp1.style.getPropertyValue('--sc') === '#123456');

// 5. uncached color extracted, painted, persisted
await tick(120);
const sp2 = q('.fav-shelf .spine[data-id="fx2"]');
ok('extracted color painted on spine', sp2.style.getPropertyValue('--sc') === '#ab0d0d');
const saved = JSON.parse(window.localStorage.getItem('spicyshelves.spinecolors') || '{}');
ok('color persisted', saved.fx2 && saved.fx2.hex === '#ab0d0d');

// 6. pull animation: spine lifts, cover pops, modal opens
const before = qa('.pull-overlay').length;
sp2.click();
ok('spine gets pulling class', sp2.classList.contains('pulling'));
await tick(150);
ok('cover overlay appears', qa('.pull-overlay').length === before + 1);
ok('overlay shows the book cover', q('.pull-overlay img').src === 'http://x/b.jpg');
await tick(1100);
ok('overlay removed after pull', qa('.pull-overlay').length === before);
ok('modal opens after animation', !!q('#f-fav'));
window.document.getElementById('m-x').click();

// 7. no cover -> short pull, no overlay
runInWindow(`library.push(${mk('fx3', '')}); renderLibrary();`);
q('.fav-shelf .spine[data-id="fx3"]').click();
await tick(150);
ok('no overlay without cover', qa('.pull-overlay').length === before);
await tick(500);
ok('modal still opens', !!q('#f-fav'));
window.document.getElementById('m-x').click();

// 8. reduced motion -> opens immediately
reduced = true;
q('.fav-shelf .spine[data-id="fx1"]').click();
await tick(80);
const spx = q('.fav-shelf .spine[data-id="fx1"]');
ok('no pulling class when reduced motion', !spx.classList.contains('pulling'));
ok('modal opens immediately', !!q('#f-fav'));
reduced = false;
window.document.getElementById('m-x').click();

// 9. in-app toggle off -> instant open, no pulling
runInWindow(`localStorage.setItem('spicyshelves.animation', 'off');`);
q('.fav-shelf .spine[data-id="fx2"]').click();
await tick(80);
ok('no pulling class when toggle off', !q('.fav-shelf .spine[data-id="fx2"]').classList.contains('pulling'));
ok('modal opens instantly when toggle off', !!q('#f-fav'));
runInWindow(`localStorage.setItem('spicyshelves.animation', 'on');`);

// 10. settings shows the animation toggle, clicking Off flips state
runInWindow(`view = 'settings'; render();`);
ok('settings has animation toggle', !!q('#th-anim'));
q('#th-anim button[data-t="off"]').click();
ok('toggle switches to off', window.localStorage.getItem('spicyshelves.animation') === 'off');
q('#th-anim button[data-t="on"]').click();
ok('toggle switches back to on', window.localStorage.getItem('spicyshelves.animation') === 'on');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
