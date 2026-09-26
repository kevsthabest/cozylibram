'use strict';

/* ---------------- unified import hub ---------------- */
// One front door for third-party backups: pick a file, the app detects the
// format, shows a preview, and imports. New sources are one registry entry
// (detect + parse); the UI, preview, and dedupe stay shared.

// Minimal CSV parser: handles quoted fields, escaped quotes, CRLF, BOM.
function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
}
function csvHeader(text) {
  const rows = parseCSV(text);
  return rows.length ? rows[0].map(h => h.trim()) : [];
}
function csvToObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
}
function cleanISBN(s) {
  const d = String(s || '').replace(/[^0-9X]/gi, '').toUpperCase();
  return (d.length === 10 || d.length === 13) ? d : '';
}
// Goodreads "2024/03/15", StoryGraph "2024/03/15" / "03/15/2024" / "March 15, 2024" → ISO.
function parseLooseDate(s) {
  s = String(s || '').trim();
  if (!s) return '';
  let d = null;
  const ymd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (ymd) d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
  else { const t = Date.parse(s); if (!isNaN(t)) d = new Date(t); }
  return d && !isNaN(d) ? d.toISOString() : '';
}
function splitNames(s) {
  return String(s || '').split(/;/).map(x => x.trim()).filter(Boolean);
}

function parseGoodreadsCSV(text) {
  return csvToObjects(text).filter(r => r['Title']).map(r => {
    const shelf = (r['Exclusive Shelf'] || '').toLowerCase();
    const status = shelf === 'read' ? 'read' : shelf === 'currently-reading' ? 'reading' : 'tbr';
    const rating = Math.max(0, Math.min(5, parseInt(r['My Rating'], 10) || 0));
    const pages = parseInt(r['Number of Pages'], 10) || 0;
    // "Last, First" → "First Last" for the primary author.
    const main = String(r['Author'] || '').replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim();
    const extra = splitNames(r['Additional Authors']).map(a =>
      a.replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim());
    const notes = [r['My Review'], r['Private Notes']].filter(Boolean).join('\n\n');
    return {
      isbn: cleanISBN(r['ISBN13'] || r['ISBN']),
      title: r['Title'],
      authors: [main].concat(extra).filter(Boolean),
      pageCount: pages,
      status: status,
      progress: status === 'read' && pages ? pages : 0,
      myRating: rating,
      owned: (parseInt(r['Owned Copies'], 10) || 0) > 0,
      dateFinished: parseLooseDate(r['Date Read']),
      dateAdded: parseLooseDate(r['Date Added']) || new Date().toISOString(),
      notes: notes,
    };
  });
}

function parseStoryGraphCSV(text) {
  const statusMap = { 'read': 'read', 'currently-reading': 'reading', 'to-read': 'tbr', 'did-not-finish': 'dnf' };
  return csvToObjects(text).filter(r => r['Title']).map(r => {
    const status = statusMap[(r['Read Status'] || '').toLowerCase()] || 'tbr';
    const rating = Math.max(0, Math.min(5, Math.round(parseFloat(r['Star Rating']) || 0)));
    const tropes = Array.from(new Set(
      String(r['Moods'] || '').split(/[,;]/).concat(String(r['Tags'] || '').split(/[,;]/))
        .map(s => s.trim()).filter(Boolean)));
    return {
      isbn: cleanISBN(r['ISBN/UID']),
      title: r['Title'],
      authors: splitNames(r['Authors']),
      status: status,
      myRating: rating,
      owned: /^(yes|true|1|y)$/i.test(String(r['Owned?'] || '').trim()),
      dateFinished: parseLooseDate(r['Last Date Read']),
      dateAdded: parseLooseDate(r['Date Added']) || new Date().toISOString(),
      notes: r['Review'] || '',
      tropes: tropes,
    };
  });
}

const IMPORT_FORMATS = [
  {
    id: 'goodreads', name: 'Goodreads',
    hint: 'goodreads.com → My Books → Import/Export → Export Library',
    detect: (text) => { const h = csvHeader(text); return h.includes('Book Id') && h.includes('Exclusive Shelf'); },
    parse: parseGoodreadsCSV,
  },
  {
    id: 'storygraph', name: 'StoryGraph',
    hint: 'StoryGraph → Manage Account → Export StoryGraph Library',
    detect: (text) => { const h = csvHeader(text); return h.includes('Title') && h.includes('Read Status') && h.includes('ISBN/UID'); },
    parse: parseStoryGraphCSV,
  },
  {
    id: 'isbn-list', name: 'ISBN list',
    hint: 'a plain text file with one ISBN per line',
    detect: (text) => {
      const parts = String(text || '').split(/[\s,;]+/).filter(Boolean);
      const isbns = parseISBNList(text);
      return isbns.length >= 3 && parts.length && isbns.length / parts.length > 0.8;
    },
    parse: (text) => parseISBNList(text).map(isbn => ({ isbn: isbn, title: '', authors: [] })),
    needsLookup: true,
  },
];

function detectImportFormat(text, filename) {
  const name = String(filename || '').toLowerCase();
  // Recognized but not mapped yet — the parser lands when a real export file arrives.
  if (name.includes('bookmory')) return { id: 'bookmory', name: 'Bookmory' };
  for (const f of IMPORT_FORMATS) {
    try { if (f.detect(text, name)) return f; } catch (e) { /* try the next one */ }
  }
  return null;
}

// Add parsed books: dedupe against the shelf, normalize, one save + render.
function importForeignBooks(books, label) {
  let added = 0, skipped = 0;
  const fresh = [];
  for (const raw of books) {
    const b = migrateBook(Object.assign({
      id: uid(), cover: '', description: '', publishedDate: '', categories: [],
      publicRating: null, ratingsCount: 0, ratings: {}, axes: ['spice'],
      myRating: 0, progress: 0, dateFinished: null, notes: '',
      status: 'tbr', owned: true, favorite: false,
    }, raw));
    if (!b.title || alreadyHave(b)) { skipped++; continue; }
    untombstone(b.id);
    fresh.push(b);
    added++;
  }
  for (let i = fresh.length - 1; i >= 0; i--) library.unshift(fresh[i]);
  saveLibrary();
  render();
  toast('Imported ' + added + ' book' + (added === 1 ? '' : 's') + ' from ' + label +
    (skipped ? ' (' + skipped + ' already on shelves)' : '') + ' ✨');
  return { added: added, skipped: skipped };
}

function handleImportFile(file) {
  const mount = document.getElementById('im-result');
  mount.innerHTML = '<p class="note">Reading file…</p>';
  const r = new FileReader();
  r.onload = () => {
    const text = String(r.result || '');
    const fmt = detectImportFormat(text, file.name);
    if (!fmt) {
      mount.innerHTML = '<p class="note">Couldn\'t recognize this file. The hub currently understands ' +
        IMPORT_FORMATS.map(f => f.name).join(', ') + ' exports.</p>';
      return;
    }
    if (fmt.id === 'bookmory') {
      mount.innerHTML = '<p class="note"><b>Bookmory</b> recognized — but its export format isn\'t mapped yet. ' +
        'Hang onto the file; support lands in a later update.</p>';
      return;
    }
    if (fmt.needsLookup) return importISBNListFile(text, mount);
    let books = [];
    try { books = fmt.parse(text); } catch (e) { books = []; }
    if (!books.length) { mount.innerHTML = '<p class="note">No books found in this file.</p>'; return; }
    const dupe = books.filter(b => b.title && alreadyHave(b)).length;
    const preview = books.slice(0, 5).map(b =>
      '<div class="result-card"><div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
      '<p class="author">' + esc((b.authors || []).join(', ') || 'Unknown author') + '</p></div></div>').join('');
    mount.innerHTML =
      '<p class="note">Detected: <b>' + esc(fmt.name) + '</b> — ' + books.length + ' books' +
      (dupe ? ' (' + dupe + ' already on your shelves, will be skipped)' : '') + '</p>' +
      preview +
      (books.length > 5 ? '<p class="note">…and ' + (books.length - 5) + ' more</p>' : '') +
      '<button class="btn block" id="im-go">Import ' + books.length + ' books</button>' +
      '<p class="note">Where to get it: ' + esc(fmt.hint) + '</p>';
    document.getElementById('im-go').addEventListener('click', () => {
      importForeignBooks(books, fmt.name);
      mount.innerHTML = '';
    });
  };
  r.readAsText(file);
}

// An ISBN-list file goes through the same lookup pipeline as the Bulk tab.
function importISBNListFile(text, mount) {
  const isbns = parseISBNList(text);
  mount.innerHTML = '<p class="note">Detected: <b>ISBN list</b> — ' + isbns.length + ' ISBNs. Looking them up…</p>' +
    '<p class="note" id="im-prog"></p><div id="im-res"></div>';
  bulkLookupISBNs(isbns, (i, n) => {
    const p = document.getElementById('im-prog');
    if (p) p.textContent = 'Looking up ' + i + ' / ' + n + '…';
  }).then(results => {
    const el = document.getElementById('im-res');
    if (!el) return;
    const found = results.filter(rr => rr.status === 'found');
    if (!found.length) { el.innerHTML = '<p class="note">No new books found.</p>'; return; }
    const rest = results.length - found.length;
    el.innerHTML = '<p class="note">' + found.length + ' found' +
      (rest ? ', ' + rest + ' not found or already on shelves' : '') + '.</p>' +
      '<button class="btn block" id="im-go">Add ' + found.length + ' books</button>';
    document.getElementById('im-go').addEventListener('click', () => {
      bulkAddBooks(found.map(rr => rr.book));
      mount.innerHTML = '';
    });
  });
}
