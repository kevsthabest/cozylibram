'use strict';

/* ---------------- discovery matching core ----------------
   Extracted from js/150-modal-discovery.js (v556): the pure matchers that decide
   whether an external row is already in the library, a duplicate of another
   row, foreign-only, junk or a mashed-title record — and the loose title
   key (v116) they share. They are a de-facto shared API (js/140 calls
   dedupeExternal, js/155 calls inLibrary, js/198 mirrors looseTitleKey), so
   they live in their own early module, loaded before all consumers. Pure
   relocation: function names, signatures and behaviour unchanged. The only
   impurity is inLibrary reading the app-global `library`. */
function normISBN(s) { return String(s || '').replace(/[^0-9X]/gi, ''); }

// true when an external result is already on her shelves (ISBN or title+author match)
// v116: title comparison uses the loose key so "Hallowed Ground - Flight &
// Glory #4" matches a shelf entry titled just "Hallowed Ground".
function inLibrary(x) {
  const isbn = normISBN(x.isbn);
  const xt = looseTitleKey(x.title);
  const xa = String(x.author || '').trim().toLowerCase();
  return library.some(b => {
    if (isbn && normISBN(b.isbn) === isbn) return true;
    return !!xt && looseTitleKey(b.title) === xt &&
      String((b.authors || [])[0] || '').trim().toLowerCase() === xa;
  });
}

// v116: loose title key for messy Open Library work titles — "(…)"
// qualifiers, " - Series #N" suffixes and a leading "The " are noise when
// deciding whether two rows are the same book.
function looseTitleKey(t, keepThe) {
  const k = String(t || '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return keepThe ? k : k.replace(/^the /, '');
}

// v116: dedupe that collapses subtitle/special-edition variants of the same
// book ("Hallowed Ground - Flight & Glory #4" vs "Hallowed ground").
function dedupeLoose(rows) {
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

// v116: works Open Library only lists in another language — noise on an English shelf.
function isForeignOnly(x) {
  const langs = x.languages || [];
  return langs.length > 0 && !langs.some(l => String(l).toLowerCase() === 'eng');
}

// v116: placeholder records, box sets and merch are not books she's missing.
function isJunkTitle(x) {
  const t = String(x.title || '');
  return t.indexOf(' / ') !== -1 ||
    /^untitled\b/i.test(t) ||
    /box set|collection set/i.test(t) ||
    /\btarot\b/i.test(t);
}

// v116: "Great and Precious Things The Last Letter" — two titles mashed into
// one bad work record. Drop it when it decomposes into two other rows.
function isMashedTitle(x, all) {
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

function dedupeExternal(rows) {
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
