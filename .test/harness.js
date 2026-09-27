// Shared test harness: loads the app's js/*.js modules (in numeric load order,
// same as index.html) into a JSDOM window as classic scripts.
const fs = require('fs');
const path = require('path');

const APP_DIR = '/home/hatch/workspace/booktok';

function jsFiles() {
  return fs.readdirSync(path.join(APP_DIR, 'js'))
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(APP_DIR, 'js', f));
}

function loadApp(window) {
  for (const file of jsFiles()) {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(file, 'utf8');
    window.document.body.appendChild(el);
  }
}

module.exports = { loadApp, jsFiles, APP_DIR, chainableSelect };

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
