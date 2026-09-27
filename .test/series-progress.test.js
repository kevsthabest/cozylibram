// Series progress badges (v108): seriesFullTotal unions owned books with
// Hardcover's full series listing (deduped), and each series card carries a
// placeholder the async fill turns into "owns X of Y".
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in series-progress tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

runInWindow(`window.__t1 = seriesFullTotal(
  [{ title: 'Alpha 1', authors: ['Ann Author'], isbn: '9780000000001' },
   { title: 'Alpha 2', authors: ['Ann Author'], isbn: '9780000000002' }],
  [{ title: 'Alpha 1', author: 'Ann Author', isbn: '9780000000001' },
   { title: 'Alpha 3', author: 'Ann Author', isbn: '9780000000003' },
   { title: 'Alpha 4', author: 'Ann Author', isbn: '9780000000004' }]);`);
ok('unions owned + Hardcover rows, deduping owned (2+3-1=4)', window.__t1 === 4);

runInWindow(`window.__t2 = seriesFullTotal(
  [{ title: 'Beta 1', authors: ['Bob Writer'], isbn: '9780000000011' }],
  [{ title: 'Beta 1', author: 'Bob Writer', isbn: '9780000000022' }]);`);
ok('different editions of the same book collapse to one', window.__t2 === 1);

runInWindow(`window.__t3 = seriesFullTotal(
  [{ title: 'Gamma 1', authors: ['Gail'], isbn: '' }], []);`);
ok('empty Hardcover listing falls back to the owned count', window.__t3 === 1);

runInWindow(`window.__t4 = seriesFullTotal(
  [{ title: 'Delta 1', authors: ['Dan'], isbn: '' }, { title: 'Delta 2', authors: ['Dan'], isbn: '' }],
  null);`);
ok('null Hardcover rows do not crash', window.__t4 === 2);

// series cards carry the owned-total placeholder for the async fill
runInWindow(`library = [
  { id: 's1', title: 'Alpha 1', authors: ['Ann Author'], status: 'read', cover: '', series: { name: 'Alpha', position: 1 } },
  { id: 's2', title: 'Alpha 2', authors: ['Ann Author'], status: 'tbr', cover: '', series: { name: 'Alpha', position: 2 } },
];`);
runInWindow(`renderSeries();`);
const ph = window.document.querySelector('[data-stotal]');
ok('series card renders the owned-total placeholder', !!ph && ph.getAttribute('data-stotal') === 'alpha');
ok('read progress is still shown', /1 \/ 2 read/.test(window.document.getElementById('view').textContent));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
