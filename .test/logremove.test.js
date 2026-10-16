// "Remove today's entry" button tests (v68). v590 (Variant B, named
// movement): the Settings Show/Hide toggle is RETIRED — the button is
// contextual (it appears only on days with an entry to remove), so the
// gate is hardcoded Show and a previously stored 'off' no longer hides it.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in logremove tests'); };

require('./harness').loadApp(window);
window.confirmModal = () => Promise.resolve(true); // v352: auto-accept the in-app removal confirm

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const book = (id) => { runInWindow(`window.__b = library.find(b => b.id === '${id}');`); return window.__b; };
const closeModal = () => q('#m-x').click();

runInWindow(`localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  const tk = dayKey(new Date());
  const M = (id, title, extra) => Object.assign({ id, isbn: '', title, authors: ['A'], cover: '',
    description: '', pageCount: null, publishedDate: '', categories: [], publicRating: null,
    ratingsCount: 0, status: 'tbr', ratings: {}, axes: [], myRating: 0, tropes: [],
    progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '' }, extra);
  // r1: stepper mis-tap — 10 phantom pages logged today
  library.push(M('r1', 'Mis-tap', { status: 'reading', pageCount: 300, progress: 50, log: [{ d: tk, from: 40, to: 50 }] }));
  // r2: no entry today
  library.push(M('r2', 'Clean Book', { status: 'read', pageCount: 200, progress: 200 }));`);

// 1. v590: no gate — the affordance is hardcoded on (context is the gate)
runInWindow(`window.__en = logRemoveEnabled();`);
ok('gate retired: logRemoveEnabled is hardcoded on', window.__en === true);
runInWindow(`localStorage.setItem('spicyshelves.logremove', 'off'); window.__en2 = logRemoveEnabled();`);
ok('a stored off from the retired setting no longer hides the button', window.__en2 === true);
runInWindow(`openDetail('r1');`);
ok('button appears whenever an entry exists', !!q('#m-rmlog'));
ok('button names the page count', (q('#m-rmlog').textContent || '').includes('10 pages'));

// 3. removing clears the entry, rolls progress back, and Save does not re-log
(async () => {
q('#m-rmlog').click();
await new Promise(r => setTimeout(r, 0)); // let the confirmModal promise chain settle
ok('entry removed', (book('r1').log || []).length === 0);
ok('progress rolled back to day start', book('r1').progress === 40);
ok('button disappears after removal', q('#m-rmlog') === null);
q('#f-progress').value = '40'; // unchanged by the user
q('#m-x').click();
ok('save does not re-log the removed entry', (book('r1').log || []).length === 0);

// 4. no button when there is nothing to remove today
runInWindow(`openDetail('r2');`);
ok('no button without a today entry', q('#m-rmlog') === null);
closeModal();

// 5. v590: the Settings toggle is gone (retired with the setting)
runInWindow(`renderSettings();`);
ok('settings no longer offers the Show/Hide toggle', q('#th-rmentry') === null);
})().then(() => {
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
});
