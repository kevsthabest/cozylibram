// Shared test harness: loads the app's js/*.js modules (in numeric load order,
// same as index.html) into a JSDOM window as classic scripts.
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';

function jsFiles() {
  return fs.readdirSync(path.join(APP_DIR, 'js'))
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(APP_DIR, 'js', f));
}

function loadApp(window) {
  // jsdom doesn't provide requestAnimationFrame; the app uses it for
  // animations. Polyfill with setTimeout so tests don't crash.
  if (typeof window.requestAnimationFrame === 'undefined') {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  for (const file of jsFiles()) {
    const el = window.document.createElement('script');
    el.textContent = classicize(fs.readFileSync(file, 'utf8'), path.basename(file));
    window.document.body.appendChild(el);
  }
}

// --- ES-module bridge-pass support (migration plan §9.2) ------------------
// jsdom cannot execute module scripts, so a converted file (a real ES
// module: named exports only, no first-party static imports) is loaded by
// stripping its module markers and injecting the identical body as a
// classic script; the file's own bridge block then publishes its surface
// on the window exactly as in production. The transform is faithful ONLY
// because bridge-everything modules carry no static imports, so meeting
// one here is a loud failure naming the file — never a silent strip. That
// tripwire is what forces the real module loader (plan §9.4) to exist
// before any import wiring begins. Classic files pass through untouched.
const RE_STATIC_IMPORT = /^[ \t]*import[ \t]+(?:\{|\*|[A-Za-z_$'"])/m;
const RE_REEXPORT = /^[ \t]*export[ \t]*(?:\{[^}]*\}|\*)[ \t]*from[ \t]*['"]/m;
const RE_EXPORT_DEFAULT = /^[ \t]*export[ \t]+default\b/m;
const RE_EXPORT_LIST = /^[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*$/gm;
const RE_EXPORT_DECL = /^([ \t]*)export[ \t]+(?=(?:async[ \t]+)?function\b|class\b|const\b|let\b|var\b)/gm;

function classicize(src, filename) {
  const name = filename || '(unknown file)';
  if (RE_STATIC_IMPORT.test(src) || RE_REEXPORT.test(src)) {
    throw new Error('classicize: ' + name + ' carries a static import/re-export — ' +
      'the bridge-everything harness cannot load it; the plan §9.4 module loader must exist first');
  }
  if (RE_EXPORT_DEFAULT.test(src)) {
    throw new Error('classicize: ' + name + ' uses export default — the migration recipe is named exports only');
  }
  if (!/^[ \t]*export[ \t]/m.test(src)) return src; // classic file: identity
  return src.replace(RE_EXPORT_LIST, '').replace(RE_EXPORT_DECL, '$1');
}

module.exports = { loadApp, jsFiles, APP_DIR, chainableSelect, classicize };

// Minimal PostgREST-style select builder for Supabase fakes: chainable
// .eq() filters, thenable so a bare `await select()` also resolves.
// `rows` are the full stored records; `project` maps one to the shape the
// real column projection would return (filter-only columns stay out).
function chainableSelect(rows, project) {
  const builder = {
    _rows: rows.slice(),
    eq(col, val) { this._rows = this._rows.filter(r => r[col] === val); return this; },
    then(resolve, reject) {
      return Promise.resolve({ data: this._rows.map(project), error: null }).then(resolve, reject);
    },
  };
  return builder;
}
