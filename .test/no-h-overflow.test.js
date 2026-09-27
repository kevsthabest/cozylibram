// Tests for v137 — no horizontal page overflow ("have to zoom out").
//
// Covered: the page can never scroll sideways (overflow-x: clip on
// html/body), long unbroken text wraps instead of widening the layout
// (quotes in the modal, quote cards, field labels incl. series names),
// and the library search input can shrink inside its flex row.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}
// crude rule lookup: selector -> declaration block (first match)
function rule(sel) {
  const i = css.indexOf(sel);
  if (i < 0) return '';
  const open = css.indexOf('{', i), close = css.indexOf('}', open);
  return css.slice(open, close);
}

ok('page: html,body clip horizontal overflow',
  /overflow-x:\s*clip/.test(rule('html, body')));
ok('modal quotes: long unbroken quote text wraps',
  /overflow-wrap:\s*break-word/.test(rule('.quote-body p')));
ok('quotes view: cards wrap long text',
  /overflow-wrap:\s*break-word/.test(rule('.q-card')));
ok('modal: field labels (series names) wrap',
  /overflow-wrap:\s*break-word/.test(rule('.field label')));
ok('library: search input can shrink in its flex row',
  /min-width:\s*0/.test(rule('.search-row .text-input')));
ok('chips keep their own internal horizontal scroll',
  /overflow-x:\s*auto/.test(rule('.chips')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
