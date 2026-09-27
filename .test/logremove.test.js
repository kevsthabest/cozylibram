// "Remove today's entry" button + Settings toggle tests (v68).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in logremove tests'); };
window.confirm = () => true; // auto-accept the removal confirm

require('./harness').loadApp(window);

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

// 1. hidden by default
runInWindow(`window.__en = logRemoveEnabled();`);
ok('toggle defaults to hidden', window.__en === false);
runInWindow(`openDetail('r1');`);
ok('no remove button when toggle is off', q('#m-rmlog') === null);
closeModal();

// 2. enabling shows the button with the page count
runInWindow(`localStorage.setItem('spicyshelves.logremove', 'on'); openDetail('r1');`);
ok('button appears when toggle is on', !!q('#m-rmlog'));
ok('button names the page count', (q('#m-rmlog').textContent || '').includes('10 pages'));

// 3. removing clears the entry, rolls progress back, and Save does not re-log
q('#m-rmlog').click();
ok('entry removed', (book('r1').log || []).length === 0);
ok('progress rolled back to day start', book('r1').progress === 40);
ok('button disappears after removal', q('#m-rmlog') === null);
q('#f-progress').value = '40'; // unchanged by the user
q('#m-save').click();
ok('save does not re-log the removed entry', (book('r1').log || []).length === 0);

// 4. no button when there is nothing to remove today
runInWindow(`openDetail('r2');`);
ok('no button without a today entry', q('#m-rmlog') === null);
closeModal();

// 5. settings toggle flips the preference
runInWindow(`renderSettings();`);
const onBtn = q('#th-rmentry button[data-t="on"]');
const offBtn = q('#th-rmentry button[data-t="off"]');
ok('settings shows the toggle', !!onBtn && !!offBtn);
ok('on is active after enabling', onBtn.classList.contains('active'));
offBtn.click();
runInWindow(`window.__v = localStorage.getItem('spicyshelves.logremove');`);
ok('toggle persists off', window.__v === 'off');
ok('off becomes active', q('#th-rmentry button[data-t="off"]').classList.contains('active'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
