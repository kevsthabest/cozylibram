// Shareable moments tests (v455): milestone cards, shelfie, DNA wiring.
// Loads app scripts from APP_DIR (env override for worktree testing).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.APP_DIR || '/home/hatch/workspace/booktok';

const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in share-moments tests'); };

// recording 2d context
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

window.Image = class {
  constructor() { this.width = 800; this.height = 600; }
  set src(v) {
    setTimeout(() => { if (this.onload) this.onload(); }, 0);
  }
};

// load app scripts in numeric order (same as index.html)
fs.readdirSync(path.join(APP_DIR, 'js'))
  .filter(f => f.endsWith('.js')).sort()
  .forEach(f => {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(APP_DIR, 'js', f), 'utf8');
    window.document.body.appendChild(el);
  });

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

(async () => {
  // ---- 1. milestone card drawing ----
  runInWindow(`
    localStorage.clear();
    localStorage.setItem('cozylibram.milestones', JSON.stringify({
      'books-finished-10': { achievedAt: '2026-10-01T00:00:00.000Z', seen: true }
    }));
    library.length = 0;
  `);
  texts = []; drawImages = 0;
  const cv = await window.drawMilestoneCard('books-finished-10');
  ok('milestone card is 1080x1920', cv && cv.width === 1080 && cv.height === 1920);
  ok('card shows milestone title', texts.some(t => t.includes('10 books finished')));
  ok('card shows warm copy', texts.some(t => t.includes('ten stories')));
  ok('card shows earned date', texts.some(t => t.includes('Earned') && t.includes('2026')));
  ok('card has branding footer', texts.some(t => t.includes('Cozy Libram')));

  // unknown milestone -> null
  const cvNull = await window.drawMilestoneCard('nope-not-real');
  ok('unknown milestone returns null', cvNull === null);

  // dynamic series milestone resolves
  runInWindow(`
    localStorage.setItem('cozylibram.milestones', JSON.stringify({
      'series-finished-acotar': { achievedAt: null, seen: true, detail: 'ACOTAR' }
    }));
  `);
  texts = []; drawImages = 0;
  const cvDyn = await window.drawMilestoneCard('series-finished-acotar');
  ok('dynamic series milestone card renders', cvDyn && texts.some(t => t.includes('ACOTAR')));

  // ---- 2. milestone page share buttons ----
  runInWindow(`
    localStorage.setItem('cozylibram.milestones', JSON.stringify({
      'books-finished-1': { achievedAt: '2024-03-01T00:00:00.000Z', seen: true },
      'books-finished-10': { achievedAt: '2026-10-01T00:00:00.000Z', seen: true }
    }));
    renderMilestones();
  `);
  const shareBtns = qa('.ms-share');
  ok('earned milestones have share buttons', shareBtns.length >= 2);
  ok('share buttons carry milestone ids',
    shareBtns.every(b => b.dataset.ms && b.dataset.ms.length > 0));
  ok('locked milestones have no share button',
    qa('.milestone-row.locked .ms-share').length === 0);

  // ---- 3. Shelf3D.capture exists in public API ----
  ok('Shelf3D.capture is a function',
    typeof window.Shelf3D !== 'undefined' && typeof window.Shelf3D.capture === 'function');
  // not mounted -> null, no throw
  let threw = false, capResult = 'unset';
  try { capResult = window.Shelf3D.capture(); } catch (e) { threw = true; }
  ok('capture returns null when not mounted', !threw && capResult === null);

  // ---- 4. shelfie card composition ----
  texts = []; drawImages = 0;
  const shelfieCv = await window.drawShelfieCard('data:image/png;base64,AAA', { books: 21, theme: 'dark' });
  // wait for the fake Image onload
  await new Promise(r => setTimeout(r, 20));
  ok('shelfie card is 1080x1920', shelfieCv && shelfieCv.width === 1080 && shelfieCv.height === 1920);

  // ---- 5. DNA share button still wired (no regression) ----
  runInWindow(`
    library.length = 0;
    library.push({
      id: 'd1', title: 'Test Book', authors: ['Author'], status: 'read',
      tropes: ['enemies to lovers'], ratings: { spice: 3 }, pageCount: 300,
      myRating: 4, dateFinished: '2026-01-15T00:00:00.000Z', log: []
    });
  `);
  const dnaHtml = window.dnaSectionHTML();
  ok('DNA section has share button', dnaHtml.includes('dna-share-btn'));

  // ---- 6. shareCanvasFile degrades without toBlob ----
  threw = false;
  try {
    const fakeCv = { width: 10, height: 10 }; // no toBlob
    await window.shareCanvasFile(fakeCv, 'x.png', 'X');
  } catch (e) { threw = true; }
  await new Promise(r => setTimeout(r, 50));
  ok('shareCanvasFile degrades gracefully without toBlob', !threw);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
