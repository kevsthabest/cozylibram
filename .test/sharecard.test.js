// Shareable book card tests (v73).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sharecard tests'); };

// recording 2d context: captures drawn text + drawImage usage
const gradStub = { addColorStop() {} };
let texts, drawImages;
const fakeCtx = new Proxy({}, {
  get(t, p) {
    if (p === 'fillText') return (s) => { texts.push(String(s)); };
    if (p === 'drawImage') return () => { drawImages++; };
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => gradStub;
    if (p === 'canvas') return {};
    return () => {};
  },
  set() { return true; }
});
window.HTMLCanvasElement.prototype.getContext = function () { return fakeCtx; };

// fake Image: loads instantly (cover path) or fails (fallback path)
let imageShouldFail = false;
window.Image = class {
  constructor() { this.width = 600; this.height = 900; }
  set src(v) {
    setTimeout(() => {
      if (imageShouldFail) { if (this.onerror) this.onerror(); }
      else if (this.onload) this.onload();
    }, 0);
  }
};

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

const book = {
  id: 'c1', isbn: '', title: 'A Court of Thorns and Roses', authors: ['Sarah J. Maas'],
  cover: 'https://example.com/cover.jpg', description: '', pageCount: 448,
  publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
  status: 'reading', ratings: { spice: 4 }, axes: ['spice'], myRating: 4.5, tropes: [],
  progress: 280, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '',
  series: { name: 'ACOTAR', position: 1 }
};

(async () => {
  // 1. full card with cover
  texts = []; drawImages = 0; imageShouldFail = false;
  runInWindow(`window.__b = ${JSON.stringify(book)};`);
  const cv = await window.drawBookCard(window.__b);
  ok('card is 1080x1920', cv && cv.width === 1080 && cv.height === 1920);
  ok('cover is drawn', drawImages === 1);
  ok('card shows title + author', texts.some(t => t.includes('Thorns')) && texts.some(t => t.includes('Sarah J. Maas')));
  ok('card shows rating + spice', texts.some(t => t.includes('♥ 4.5')) && texts.some(t => t.includes('🌶️🌶️🌶️🌶️')));
  ok('card shows series', texts.some(t => t.includes('ACOTAR')));
  ok('card shows reading progress', texts.some(t => t.includes('63%')));

  // 2. no-cover fallback: typographic card, no drawImage
  texts = []; drawImages = 0; imageShouldFail = true;
  runInWindow(`window.__b2 = ${JSON.stringify(Object.assign({}, book, { id: 'c2', cover: '', status: 'tbr' }))};`);
  const cv2 = await window.drawBookCard(window.__b2);
  ok('fallback card renders', cv2 && cv2.width === 1080);
  ok('fallback draws no cover', drawImages === 0);
  ok('fallback shows title + TBR', texts.some(t => t.includes('Thorns')) && texts.some(t => t.includes('On my TBR')));

  // 3. tainted canvas (non-CORS cover) falls back to typographic card
  texts = []; drawImages = 0; imageShouldFail = false;
  const origTD = window.HTMLCanvasElement.prototype.toDataURL;
  window.HTMLCanvasElement.prototype.toDataURL = function () {
    throw Object.assign(new Error('tainted'), { name: 'SecurityError' });
  };
  const cv3 = await window.drawBookCard(window.__b);
  window.HTMLCanvasElement.prototype.toDataURL = origTD;
  ok('tainted cover falls back gracefully', cv3 && texts.some(t => t.includes('Thorns')));

  // 4. share entry: button exists in the detail modal
  runInWindow(`(function(){
    localStorage.clear();
    localStorage.setItem('spicyshelves.animation', 'off');
    library.length = 0;
    library.push(Object.assign({}, ${JSON.stringify(book)}, { id: 'm1' }));
    openDetail('m1');
  })();`);
  ok('detail modal has a Share button', !!q('#m-share'));

  // 5. shareBookCard on a toBlob-less canvas shows the unsupported toast, no crash
  let threw = false;
  try { await window.shareBookCard('m1'); } catch (e) { threw = true; }
  await new Promise(r => setTimeout(r, 50));
  ok('share degrades gracefully without toBlob', !threw);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
