// Reading-progress tests: quick steppers, manual total pages, card bars.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in progress tests'); };

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
const LS = 'spicyshelves.library.v1';

runInWindow(`localStorage.clear();
  window.__b1 = { id: 'bp1', isbn: '', title: 'Progress Test', authors: ['Tester'], cover: '', description: '', pageCount: 400, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, status: 'reading', ratings: {}, axes: [], myRating: 0, tropes: [], progress: 100, dateAdded: new Date().toISOString(), dateFinished: null, notes: '' };
  library.push(window.__b1);
  openDetail('bp1');`);

function stored(id) {
  return JSON.parse(window.localStorage.getItem(LS)).find(x => x.id === id);
}
function step(d) {
  qa('#m-progress [data-step]').find(x => x.dataset.step === d).click();
}

// 1. stepper section renders for a reading book, +10 saves immediately
ok('modal opened', !!q('#modal-root .modal'));
ok('progress section visible for reading book', !!q('#m-progress .stepper-row'));
ok('shows current page + pct', /Page\s*100\s*of 400/.test(q('#m-progress').textContent) && q('#m-progress').textContent.includes('25%'));
step('+10');
ok('stepper +10 updates book', window.__b1.progress === 110);
ok('stepper syncs current-page input', q('#f-progress').value === '110');
ok('stepper persists to localStorage', stored('bp1').progress === 110);

// 2. steppers clamp at total and at zero
runInWindow(`window.__b1.progress = 395; openDetail('bp1');`);
step('+10');
ok('stepper clamps at total pages', window.__b1.progress === 400);
runInWindow(`window.__b1.progress = 1; openDetail('bp1');`);
step('-1');
ok('stepper clamps at zero', window.__b1.progress === 0);

// 3. manual total pages via Save (TBR book, no pageCount from metadata)
runInWindow(`
  window.__b2 = Object.assign({}, window.__b1, { id: 'bp2', status: 'tbr', pageCount: null, progress: 0 });
  library.push(window.__b2);
  openDetail('bp2');`);
ok('no stepper section for TBR book', !q('#m-progress .stepper-row'));
ok('total-pages field present even without pageCount', !!q('#f-pagecount'));
q('#f-pagecount').value = '300';
q('#f-progress').value = '50';
q('#m-save').click();
ok('manual total pages saved', window.__b2.pageCount === 300);
ok('manual current page saved', window.__b2.progress === 50);

// 4. progress clamps to total on save
runInWindow(`
  window.__b3 = Object.assign({}, window.__b1, { id: 'bp3', status: 'reading', pageCount: 200, progress: 10 });
  library.push(window.__b3);
  openDetail('bp3');`);
q('#f-progress').value = '999';
q('#m-save').click();
ok('progress clamped to total on save', window.__b3.progress === 200);

// 5. marking as read auto-completes progress
runInWindow(`
  window.__b4 = Object.assign({}, window.__b1, { id: 'bp4', status: 'reading', pageCount: 250, progress: 120 });
  library.push(window.__b4);
  openDetail('bp4');`);
qa('#f-status button').find(x => x.dataset.s === 'read').click();
ok('progress section hides when moved off reading', !q('#m-progress .stepper-row'));
q('#m-save').click();
ok('marking read sets progress = total', window.__b4.progress === 250);
ok('marking read sets dateFinished', !!window.__b4.dateFinished);

// 6. card shows progress bar for reading books only
let cardReading = '';
runInWindow(`window.__cardR = bookCard(window.__b1, 0);`);
cardReading = window.__cardR;
ok('reading card has progress bar', cardReading.includes('card-progress') && cardReading.includes('0 / 400'));
runInWindow(`window.__cardT = bookCard(window.__b2, 0);`);
ok('tbr card has no progress bar', !window.__cardT.includes('card-progress'));

// 7. switching back to reading re-shows the section with live values
runInWindow(`openDetail('bp4');`); // bp4 is now read
qa('#f-status button').find(x => x.dataset.s === 'reading').click();
ok('section reappears when moved back to reading', !!q('#m-progress .stepper-row'));
ok('section shows completed progress', q('#m-progress').textContent.includes('250'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
