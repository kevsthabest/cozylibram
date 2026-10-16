// Book modal de-clunk (v111, v174): sticky Save/Delete/Share bar; quotes
// moved from the v111 tap-to-expand section to the v174 Notes tab.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in modal-cleanup tests'); };

require('./harness').loadApp(window);

const css = fs.readFileSync('/home/hatch/workspace/booktok/styles.css', 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

runInWindow(`library = [
  { id: 'q1', title: 'Quoted Book', authors: ['Ann Author'], status: 'read', cover: '',
    tropes: [], notes: '', quotes: [{ t: 'a fine line', p: 42 }] },
];`);
runInWindow(`openDetail('q1');`);

ok('autosave: no save bar in the detail modal',
  !window.document.getElementById('m-save') &&
  !window.document.querySelector('#modal-root .modal-actions'));
ok('Share / Remove stay in the header cluster; save status sits beside them',
  !!window.document.getElementById('m-savestate') &&
  !!window.document.querySelector('.d-topactions #m-share') &&
  !!window.document.querySelector('.d-topactions #m-del'));
ok('generic modal-actions CSS (other sheets) untouched',
  /\.modal-actions\s*\{[^}]*position:\s*sticky[^}]*bottom:/s.test(css));

const det = null; // v174: the v111 quotes collapsible is gone — quotes live on the Notes tab now.
ok('Quotes live on the Notes tab',
  !!window.document.querySelector('#dtab-notes #m-quotes'));
ok('quotes tab panel starts hidden', window.document.getElementById('dtab-notes').hidden === true);
ok('quote count shown on the Notes tab label', (() => {
  const labels = Array.from(window.document.querySelectorAll('#dtab-notes .field > label'));
  return labels.some(l => /quotes/i.test(l.textContent) && /· 1/.test(l.textContent));
})());
ok('quote still renders when the tab opens', (() => {
  window.document.querySelector('[data-dtab="notes"]').click();
  return /a fine line/.test(window.document.getElementById('dtab-notes').textContent);
})());
ok('notes textarea untouched', !!window.document.getElementById('f-notes'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
