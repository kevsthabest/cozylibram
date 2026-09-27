// Book modal de-clunk (v111): sticky Save/Delete/Share bar and the Quotes
// section collapsed behind a tap-to-expand.
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

const actions = window.document.querySelector('.modal-actions');
ok('action bar still rendered', !!actions);
ok('Save / Share / Remove buttons intact',
  !!window.document.getElementById('m-save') &&
  !!window.document.getElementById('m-share') &&
  !!window.document.getElementById('m-del'));
ok('action bar is sticky-bottom via CSS',
  /\.modal-actions\s*\{[^}]*position:\s*sticky[^}]*bottom:/s.test(css));

const det = window.document.querySelector('details.m-collapsible');
ok('Quotes live in a collapsed details section',
  !!det && det.open === false && !!det.querySelector('#m-quotes'));
ok('quote count shown on the collapsed header',
  /· 1/.test(det.querySelector('summary').textContent));
ok('quote still renders when expanded',
  (() => { det.open = true; return /a fine line/.test(det.textContent); })());
ok('notes textarea untouched', !!window.document.getElementById('f-notes'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
