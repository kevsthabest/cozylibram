// Settings accordions (v112): the 11 sections become collapsible cards with
// persisted open/closed state; all existing controls keep working.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in settings-accordions tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

runInWindow(`localStorage.removeItem('spicyshelves.setgroups'); library = [];`);
runInWindow(`view = 'settings'; renderSettings();`);
const groups = window.document.querySelectorAll('#view > .set-group');
ok('all 11 sections become accordion cards', groups.length === 11);
ok('first section open by default, rest collapsed',
  groups[0].open === true && groups[1].open === false && groups[10].open === false);
ok('card headers carry the section titles',
  /Your shelves at a glance/.test(groups[0].querySelector('summary').textContent) &&
  /Covers/.test(groups[7].querySelector('summary').textContent));
ok('existing controls survive the wrapping',
  !!window.document.getElementById('cover-bulk') &&
  !!window.document.getElementById('cover-offline') &&
  !!window.document.getElementById('meta-verify') &&
  !!window.document.getElementById('ap-update'));

// toggling persists; a re-render restores it
runInWindow(`
  const g2 = document.querySelectorAll('#view > .set-group')[2];
  g2.open = false; document.querySelectorAll('#view > .set-group')[0].open = false;
  g2.open = true;
  g2.dispatchEvent(new Event('toggle'));
  window.__saved = localStorage.getItem('spicyshelves.setgroups');
`);
ok('toggle persists open sections', window.__saved === '[2]');
runInWindow(`renderSettings();`);
const groups2 = window.document.querySelectorAll('#view > .set-group');
ok('re-render restores persisted state',
  groups2[2].open === true && groups2[0].open === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
