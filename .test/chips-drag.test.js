// v238: drag-to-scroll for horizontal chip rows (desktop mouse).
// Pure DOM behavior: a mouse drag scrolls an overflowing .chips row and
// swallows the click that follows (so chips don't toggle mid-drag); a plain
// click passes through; non-overflowing rows and touch pointers are ignored.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in chips-drag tests'); };
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const doc = window.document;

function ptr(type, target, props) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { pointerType: 'mouse', button: 0, clientX: 0 }, props);
  target.dispatchEvent(ev);
}
function tap(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function makeRow() {
  const row = doc.createElement('div');
  row.className = 'chips';
  row.innerHTML = '<button class="chip">A</button><button class="chip">B</button><button class="chip">C</button>';
  doc.getElementById('view').appendChild(row);
  // jsdom does no layout — fake an overflowing row.
  Object.defineProperty(row, 'scrollWidth', { value: 300, configurable: true });
  Object.defineProperty(row, 'clientWidth', { value: 100, configurable: true });
  return row;
}

(async () => {
  // 1. drag scrolls the row and swallows the follow-up click
  const row = makeRow();
  let clicked = 0;
  row.querySelector('.chip').addEventListener('click', () => clicked++);
  ptr('pointerdown', row.querySelector('.chip'), { clientX: 100 });
  ptr('pointermove', doc, { clientX: 60 });
  ok('drag scrolls the row', row.scrollLeft === 40);
  ok('dragging class applied mid-drag', row.classList.contains('dragging'));
  ptr('pointerup', doc, {});
  ok('dragging class removed on release', !row.classList.contains('dragging'));
  tap(row.querySelector('.chip'));
  ok('click after a drag is swallowed', clicked === 0);

  // 2. a plain click still works
  const row2 = makeRow();
  let clicked2 = 0;
  row2.querySelector('.chip').addEventListener('click', () => clicked2++);
  ptr('pointerdown', row2.querySelector('.chip'), { clientX: 100 });
  ptr('pointerup', doc, {});
  tap(row2.querySelector('.chip'));
  ok('plain click passes through', clicked2 === 1);

  // 3. non-overflowing rows are ignored
  const row3 = makeRow();
  Object.defineProperty(row3, 'scrollWidth', { value: 100 });
  ptr('pointerdown', row3, { clientX: 100 });
  ptr('pointermove', doc, { clientX: 10 });
  ok('no drag state on a non-overflowing row', !row3.classList.contains('dragging') && row3.scrollLeft === 0);
  ptr('pointerup', doc, {});

  // 4. touch pointers are ignored (native scroll handles them)
  const row4 = makeRow();
  ptr('pointerdown', row4, { clientX: 100, pointerType: 'touch' });
  ptr('pointermove', doc, { clientX: 10, pointerType: 'touch' });
  ok('touch drag ignored', row4.scrollLeft === 0);
  ptr('pointerup', doc, {});

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
