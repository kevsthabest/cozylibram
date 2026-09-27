// Previously-read toggle + phantom-log fix tests (v67).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in prevread tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.toISOString(); };
const book = (id) => { runInWindow(`window.__b = library.find(b => b.id === '${id}');`); return window.__b; };
const closeModal = () => q('#m-x').click();

runInWindow(`localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  const M = (id, title, extra) => Object.assign({ id, isbn: '', title, authors: ['A'], cover: '',
    description: '', pageCount: null, publishedDate: '', categories: [], publicRating: null,
    ratingsCount: 0, status: 'tbr', ratings: {}, axes: [], myRating: 0, tropes: [],
    progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: '' }, extra);
  library.push(M('p1', 'Page Count Fix', { status: 'read', pageCount: 300, progress: 300, dateFinished: '${isoDaysAgo(400)}' }));
  library.push(M('p2', 'Backfill Me', { status: 'tbr', pageCount: 250 }));
  library.push(M('p3', 'Fresh Finish', { status: 'tbr', pageCount: 200 }));
  library.push(M('p4', 'Steady Reader', { status: 'tbr', pageCount: 300 }));`);

// 1. fixing the total on a finished book must not fabricate a reading session
runInWindow(`openDetail('p1');`);
q('#f-pagecount').value = '280';
q('#m-save').click();
ok('page count corrected', book('p1').pageCount === 280);
ok('no phantom log entry', (book('p1').log || []).length === 0);
ok('progress capped to new total', book('p1').progress === 280);
ok('old finish date untouched', !!book('p1').dateFinished);

// 2. previously-read toggle on a backfilled book
runInWindow(`openDetail('p2');`);
q('#f-status button[data-s="read"]').click();
runInWindow(`window.__stamped = !!editingDraft.dateFinished;`);
ok('read stamps today while toggle is off', window.__stamped === true);
q('#f-prevread').checked = true;
q('#f-prevread').dispatchEvent(new window.Event('change', { bubbles: true }));
runInWindow(`window.__cleared = !editingDraft.dateFinished;`);
ok('checking toggle clears the fresh stamp', window.__cleared === true);
q('#m-save').click();
ok('saved as read', book('p2').status === 'read');
ok('no finish date kept', !book('p2').dateFinished);
ok('no log entries', (book('p2').log || []).length === 0);
ok('flag persisted', book('p2').previouslyRead === true);

// 3. normal finish keeps the old behavior (stamp + completion log)
runInWindow(`openDetail('p3');`);
q('#f-status button[data-s="read"]').click();
q('#m-save').click();
ok('normal finish stamps today', !!book('p3').dateFinished);
const lg = book('p3').log || [];
ok('completion delta logged', lg.length === 1 && lg[0].to - lg[0].from === 200);

// 4. toggle defaults from history
runInWindow(`openDetail('p1');`);
ok('pre-checked for a 400-day-old finish', q('#f-prevread').checked === true);
closeModal();
runInWindow(`openDetail('p3');`);
ok('unchecked for a fresh finish', q('#f-prevread').checked === false);
closeModal();

// 5. genuine progress edits still log
runInWindow(`openDetail('p4');`);
q('#f-status button[data-s="reading"]').click();
q('#f-progress').value = '40';
q('#m-save').click();
const lg2 = book('p4').log || [];
ok('manual progress edit logs pages', lg2.length === 1 && lg2[0].to - lg2[0].from === 40);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
