// v211: "Audiobook" is a format, not a trope. Open Library subjects leak the
// singular 'audiobook' past 061's old stopword set into book.tropes; the fix
// is a canonical TROPE_FORMAT_JUNK set shared by seedTropes and a
// migrateBook strip that cleans already-seeded books.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const get = (js) => { runInWindow('window.__v = (' + js + ');'); return window.__v; };

(async () => {
  // canonical set exists and covers the format junk
  ok('TROPE_FORMAT_JUNK is a Set', get('TROPE_FORMAT_JUNK instanceof Set'));
  for (const w of ['audiobook', 'audiobooks', 'ebook', 'ebooks', 'paperback', 'hardcover', 'textbook', 'textbooks', 'large type']) {
    ok('junk set has ' + w, get('TROPE_FORMAT_JUNK.has(' + JSON.stringify(w) + ')'));
  }
  ok('junk set does not eat real tropes', !get('TROPE_FORMAT_JUNK.has("mafia romance")'));

  // seedTropes no longer plants the singular 'audiobook' from OL-style subjects
  runInWindow('window.__b = { categories: ["Fiction / Audiobook", "Romance / Contemporary"] }; seedTropes(window.__b);');
  const seeded = window.__b.tropes || [];
  ok('seedTropes skips Audiobook', !seeded.includes('audiobook'));
  ok('seedTropes keeps real genres', seeded.includes('romance') || seeded.includes('contemporary'));

  // migrateBook strips already-seeded junk from both arrays, keeps real tropes
  runInWindow('window.__m = { tropes: ["Audiobook", "mafia romance", "EBOOK"], tropesAuto: ["audiobook", "forced proximity"], _mtime: 123 }; ' +
    'window.__m0 = window.__m._mtime; migrateBook(window.__m);');
  const m = window.__m;
  ok('migrateBook strips Audiobook from tropes', !(m.tropes || []).some(t => String(t).toLowerCase() === 'audiobook'));
  ok('migrateBook strips EBOOK from tropes', !(m.tropes || []).some(t => String(t).toLowerCase() === 'ebook'));
  ok('migrateBook keeps real tropes', (m.tropes || []).includes('mafia romance'));
  ok('migrateBook strips junk from tropesAuto', !(m.tropesAuto || []).some(t => String(t).toLowerCase() === 'audiobook'));
  ok('migrateBook keeps real suggestions', (m.tropesAuto || []).includes('forced proximity'));
  ok('migrateBook bumps _mtime when junk removed', m._mtime > window.__m0);

  // clean book: no strip, no _mtime bump
  runInWindow('window.__c = { tropes: ["mafia romance"], tropesAuto: ["forced proximity"], _mtime: 456 }; migrateBook(window.__c);');
  ok('migrateBook leaves clean tropes alone', window.__c.tropes.length === 1 && window.__c.tropesAuto.length === 1);
  ok('migrateBook does not bump _mtime when nothing removed', window.__c._mtime === 456);

  // Hardcover-tag path still filters it too
  ok('cleanTag still rejects Audiobook', get('cleanTag("Audiobook")') === null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
