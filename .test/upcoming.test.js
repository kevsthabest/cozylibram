// Upcoming releases (v113): release dates, countdowns, and the wishlist
// "Coming soon" section.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in upcoming tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const isoIn = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// --- countdown helpers ---
ok('daysUntil counts future days', window.daysUntil(isoIn(9)) === 9);
ok('daysUntil today is 0', window.daysUntil(isoIn(0)) === 0);
ok('daysUntil past is negative', window.daysUntil(isoIn(-3)) === -3);
ok('daysUntil rejects garbage', window.daysUntil('2027') === null && window.daysUntil('') === null);
ok('releaseCountdown phrasing',
  window.releaseCountdown(isoIn(9)) === 'in 9 days' &&
  window.releaseCountdown(isoIn(1)) === 'tomorrow' &&
  window.releaseCountdown(isoIn(0)) === 'today' &&
  window.releaseCountdown(isoIn(-3)) === '');

// --- metadata factory adopts full publishedDates ---
runInWindow(`window.__rd1 = normalizeVolume({ volumeInfo: { title: 'T', authors: ['A'], publishedDate: '${isoIn(30)}' } }).releaseDate;`);
ok('full publishedDate becomes releaseDate', window.__rd1 === isoIn(30));
runInWindow(`window.__rd2 = normalizeVolume({ volumeInfo: { title: 'T', authors: ['A'], publishedDate: '2027' } }).releaseDate;`);
ok('year-only publishedDate is not a releaseDate', window.__rd2 === undefined);

// --- Hardcover doc adopts release_date without overwriting ---
runInWindow(`
  const hb1 = { categories: [] }; applyHardcoverDoc(hb1, { release_date: '2027-05-01T00:00:00' });
  const hb2 = { categories: [], releaseDate: '2026-01-01' }; applyHardcoverDoc(hb2, { release_date: '2027-05-01' });
  window.__hb1 = hb1.releaseDate; window.__hb2 = hb2.releaseDate;
`);
ok('Hardcover release_date adopted when empty', window.__hb1 === '2027-05-01');
ok('existing releaseDate never overwritten', window.__hb2 === '2026-01-01');

// --- modal: release line, date input, save round-trip ---
runInWindow(`library = [
  { id: 'u1', title: 'Soon Book', authors: ['Ann Author'], status: 'tbr', owned: 'tobuy', cover: '',
    tropes: [], releaseDate: '${isoIn(12)}', dateAdded: '2026-09-01T00:00:00.000Z' },
  { id: 'u2', title: 'Old Book', authors: ['Ann Author'], status: 'tbr', owned: 'tobuy', cover: '',
    tropes: [], dateAdded: '2026-09-02T00:00:00.000Z' },
];`);
runInWindow(`openDetail('u1');`);
const relLine = window.document.querySelector('.release-line');
ok('modal shows release countdown line',
  !!relLine && /in 12 days/.test(relLine.textContent));
const dateInput = window.document.getElementById('f-releasedate');
ok('release date input prefilled', !!dateInput && dateInput.value === isoIn(12));
runInWindow(`
  document.getElementById('f-releasedate').value = '${isoIn(20)}';
  document.getElementById('m-save').click();
  window.__savedRD = library.find(b => b.id === 'u1').releaseDate;
`);
ok('save persists the release date', window.__savedRD === isoIn(20));

// --- wishlist: Coming soon section, sorted by date ---
runInWindow(`library.find(b => b.id === 'u1').releaseDate = '${isoIn(20)}';
  library.push({ id: 'u3', title: 'Sooner Book', authors: ['Zed'], status: 'tbr', owned: 'tobuy',
    cover: '', tropes: [], releaseDate: '${isoIn(5)}', dateAdded: '2026-09-03T00:00:00.000Z' });
  view = 'wishlist'; renderWishlist();`);
const section = window.document.querySelector('.wish-section');
ok('Coming soon section rendered', !!section && /Coming soon/.test(section.textContent));
const pills = [...window.document.querySelectorAll('.up-pill')].map(p => p.textContent);
ok('upcoming sorted by date with countdowns',
  pills.length === 2 && /in 5 days/.test(pills[0]) && /in 20 days/.test(pills[1]));
const cards = [...window.document.querySelectorAll('#view .book-card h3')].map(h => h.textContent);
ok('upcoming books lead the wishlist', cards[0] === 'Sooner Book' && cards[1] === 'Soon Book' && cards[2] === 'Old Book');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
