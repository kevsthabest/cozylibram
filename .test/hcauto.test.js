// Hardcover auto-enrich sweep tests (v72).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in hcauto tests'); }; // enrichment misses

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

const seed = () => runInWindow(`(function(){
  localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  const B = (id, extra) => Object.assign({ id, isbn: '', title: 'T' + id, authors: ['A'], cover: '',
    description: '', pageCount: 100, publishedDate: '', categories: [], publicRating: null,
    ratingsCount: 0, status: 'read', ratings: {}, axes: [], myRating: 0, tropes: [],
    progress: 100, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '' }, extra);
  library.push(B('b1', {}));                                            // target
  library.push(B('b2', { hcEnriched: true }));                          // already done
  library.push(B('b3', { hcCheckedAt: Date.now() }));                   // miss, checked recently
  library.push(B('b4', { hcCheckedAt: Date.now() - 8 * 86400000 }));     // miss, retry due
  window.SPICY_CONFIG = { hardcoverToken: 'fake-token-for-tests' };
})();`);

(async () => {
  // 1. toggle defaults on, can be turned off
  seed();
  ok('auto-enrich defaults on', window.hcAutoEnabled() === true);
  runInWindow(`localStorage.setItem('spicyshelves.hc_auto', '0');`);
  ok('auto-enrich can be disabled', window.hcAutoEnabled() === false);

  // 2. target selection: unenriched, skipping recent misses
  seed();
  const ids = window.hcSweepTargets().map(b => b.id).sort();
  ok('sweep targets are unenriched + retry-due', JSON.stringify(ids) === JSON.stringify(['b1', 'b4']));

  // 3. miss path: no network → books get hcCheckedAt, nothing crashes
  seed();
  await window.autoEnrichSweep();
  runInWindow(`window.__snap = Object.fromEntries(library.map(b => [b.id, { hc: !!b.hcEnriched, ca: b.hcCheckedAt || 0 }])); window.__busy = hcEnrichBusy;`);
  const byId = window.__snap;
  ok('misses are stamped so they are not re-hammered',
    byId.b1.ca > 0 && byId.b4.ca > 0);
  ok('already-enriched books untouched', byId.b2.hc === true && byId.b2.ca === 0);
  ok('sweep is idle afterwards', window.__busy === false);

  // 4. hit path: stub enrichHardcover to succeed
  seed();
  runInWindow(`window.__origEnrich = enrichHardcover;
    enrichHardcover = async (b) => { b.hcEnriched = true; return true; };`);
  await window.autoEnrichSweep();
  runInWindow(`window.__snap = Object.fromEntries(library.map(b => [b.id, !!b.hcEnriched]));`);
  const after = window.__snap;
  ok('hits get enriched', after.b1 === true && after.b4 === true);
  runInWindow(`enrichHardcover = window.__origEnrich;`);

  // 5. busy flag blocks concurrent runs
  seed();
  runInWindow(`hcEnrichBusy = true;`);
  await window.autoEnrichSweep();
  runInWindow(`window.__snap = Object.fromEntries(library.map(b => [b.id, b.hcCheckedAt || 0]));`);
  const still = window.__snap;
  ok('concurrent sweep is skipped', !still.b1);
  runInWindow(`hcEnrichBusy = false;`);

  // 6. disabled toggle blocks the sweep
  seed();
  runInWindow(`localStorage.setItem('spicyshelves.hc_auto', '0');`);
  await window.autoEnrichSweep();
  runInWindow(`window.__snap = Object.fromEntries(library.map(b => [b.id, b.hcCheckedAt || 0]));`);
  const off = window.__snap;
  ok('disabled sweep does nothing', !off.b1);

  // 7. settings toggle UI
  seed();
  runInWindow(`view = 'settings'; renderSettings();`);
  ok('settings has the auto-enrich toggle', !!q('#hc-autoseg'));
  const offBtn = Array.from(window.document.querySelectorAll('#hc-autoseg button'))
    .find(b => b.dataset.t === 'off');
  offBtn.click();
  ok('toggle writes the preference',
    window.localStorage.getItem('spicyshelves.hc_auto') === '0' && offBtn.classList.contains('active'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
