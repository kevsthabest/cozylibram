'use strict';

/* js/056-discovery-match.js — Discovery matching core: the matchers
 * that decide whether an external search row is already in the
 * library, a duplicate of another row, foreign-only, junk, or a
 * mashed-title record.
 *
 * Extracted from js/150-modal-discovery.js (v556) because the matchers
 * are a de-facto shared API: js/140-collections.js calls
 * dedupeExternal, js/155-authors.js calls inLibrary, and js/150 itself
 * reads seven of the eight — all as globals through the window bridge at
 * the bottom of this file, so this module loads early, before its
 * consumers. The matchers are pure functions of their arguments,
 * with one stated exception: inLibrary reads the app-global
 * `library` (owned by the classic js/040-storage.js). Nothing here reads
 * another module's bridge-published names.
 *
 * The shared yardstick is looseTitleKey: "(…)" qualifiers,
 * " - Series #N" suffixes and a leading "The " are noise when
 * deciding whether two rows are the same book, so the key strips
 * them before comparison (v116).
 */

export function normISBN(s) { return String(s || '').replace(/[^0-9X]/gi, ''); }

// True when an external result is already on her shelves (ISBN or
// title+author match). Title comparison uses the loose key so
// "Hallowed Ground - Flight & Glory #4" matches a shelf entry titled
// just "Hallowed Ground" (v116).
export function inLibrary(x) {
  const isbn = normISBN(x.isbn);
  const xt = looseTitleKey(x.title);
  const xa = String(x.author || '').trim().toLowerCase();
  return library.some(b => {
    if (isbn && normISBN(b.isbn) === isbn) return true;
    return !!xt && looseTitleKey(b.title) === xt &&
      String((b.authors || [])[0] || '').trim().toLowerCase() === xa;
  });
}

// Loose title key for messy Open Library work titles — "(…)"
// qualifiers, " - Series #N" suffixes and a leading "The " are noise
// when deciding whether two rows are the same book (v116).
export function looseTitleKey(t, keepThe) {
  const k = String(t || '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return keepThe ? k : k.replace(/^the /, '');
}

// Dedupe that collapses subtitle/special-edition variants of the
// same book ("Hallowed Ground - Flight & Glory #4" vs "Hallowed
// ground") (v116).
export function dedupeLoose(rows) {
  const seenTitle = new Set();
  const seenIsbn = new Set();
  return rows.filter(x => {
    const t = looseTitleKey(x.title) + '|' + String(x.author || '').trim().toLowerCase();
    const isbn = normISBN(x.isbn);
    if ((t !== '|' && seenTitle.has(t)) || (isbn && seenIsbn.has(isbn))) return false;
    if (t !== '|') seenTitle.add(t);
    if (isbn) seenIsbn.add(isbn);
    return true;
  });
}

// Works Open Library only lists in another language — noise on an
// English shelf (v116).
export function isForeignOnly(x) {
  const langs = x.languages || [];
  return langs.length > 0 && !langs.some(l => String(l).toLowerCase() === 'eng');
}

// Placeholder records, box sets and merch are not books she's
// missing (v116).
export function isJunkTitle(x) {
  const t = String(x.title || '');
  return t.indexOf(' / ') !== -1 ||
    /^untitled\b/i.test(t) ||
    /box set|collection set/i.test(t) ||
    /\btarot\b/i.test(t);
}

// "Great and Precious Things The Last Letter" — two titles mashed
// into one bad work record. Drop it when it decomposes into two
// other rows (v116).
export function isMashedTitle(x, all) {
  const k = looseTitleKey(x.title, true);
  if (!k) return false;
  const keys = new Set(all.map(y => looseTitleKey(y.title, true)));
  for (const other of keys) {
    if (!other || other === k || !k.startsWith(other)) continue;
    const rest = k.slice(other.length).trim();
    if (rest && keys.has(rest)) return true;
  }
  return false;
}

export function dedupeExternal(rows) {
  // Dedupe primarily by title+author so different editions of the same book
  // (different ISBNs) collapse; ISBN catches exact-duplicate rows too.
  const seenTitle = new Set();
  const seenIsbn = new Set();
  return rows.filter(x => {
    const t = String(x.title || '').trim().toLowerCase() + '|' + String(x.author || '').trim().toLowerCase();
    const isbn = normISBN(x.isbn);
    if ((t !== '|' && seenTitle.has(t)) || (isbn && seenIsbn.has(isbn))) return false;
    if (t !== '|') seenTitle.add(t);
    if (isbn) seenIsbn.add(isbn);
    return true;
  });
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/140-collections.js, js/150-modal-discovery.js and js/155-authors.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups resolve
   through the global object, so the caller needs no changes. Module
   scripts are deferred, so the bridge is in place before any consumer
   can run. Remove a name from this bridge only when its last
   window-reading caller has wired the read as an import (ADR-003). */
window.normISBN = normISBN;
window.inLibrary = inLibrary;
window.looseTitleKey = looseTitleKey;
window.dedupeLoose = dedupeLoose;
window.isForeignOnly = isForeignOnly;
window.isJunkTitle = isJunkTitle;
window.isMashedTitle = isMashedTitle;
window.dedupeExternal = dedupeExternal;
