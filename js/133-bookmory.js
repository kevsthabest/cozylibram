'use strict';

/* ---------------- Bookmory import (v44) ---------------- */
// Reads a Bookmory `Database.bookmory` export directly: it's a ZIP containing
// `new_bookmory.db`, a SQLite file with a single key/value `entry` table
// (Sembast format). Everything below is dependency-free: a minimal ZIP reader,
// a pure-JS inflate (deflate) implementation, and a minimal SQLite reader that
// understands just enough of the file format to scan the `entry` table.

/* ---- pure-JS inflate (raw deflate stream, RFC 1951) ---- */
function bmMakeHuffman(lengths) {
  let maxbits = 0;
  lengths.forEach(l => { if (l > maxbits) maxbits = l; });
  const bl_count = new Array(maxbits + 1).fill(0);
  lengths.forEach(l => { if (l > 0) bl_count[l]++; });
  const nextcode = new Array(maxbits + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= maxbits; b++) { code = (code + bl_count[b - 1]) << 1; nextcode[b] = code; }
  // byLen[len][reversedCode] = symbol; deflate packs codes LSB-first, so the
  // canonical codes are bit-reversed for comparison against the bit stream.
  const byLen = [];
  for (let l = 1; l <= maxbits; l++) byLen[l] = new Int16Array(1 << l).fill(-1);
  lengths.forEach((l, n) => {
    if (!l) return;
    const c = nextcode[l]++;
    let rev = 0;
    for (let i = 0; i < l; i++) rev = (rev << 1) | ((c >> i) & 1);
    byLen[l][rev] = n;
  });
  return function (getBit) {
    let c = 0;
    for (let l = 1; l <= maxbits; l++) {
      c |= getBit() << (l - 1);
      const s = byLen[l][c];
      if (s >= 0) return s;
    }
    throw new Error('invalid huffman code');
  };
}

const BM_LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const BM_LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const BM_DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const BM_DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const BM_CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function bmInflateRaw(data) {
  const out = [];
  let pos = 0, hold = 0, bits = 0;
  const need = n => { while (bits < n) { hold |= data[pos++] << bits; bits += 8; } };
  const get = n => { need(n); const v = hold & ((1 << n) - 1); hold >>>= n; bits -= n; return v; };
  const getBit = () => get(1);
  const fixedLit = bmMakeHuffman(
    [].concat(new Array(144).fill(8), new Array(112).fill(9), new Array(24).fill(7), new Array(8).fill(8)));
  const fixedDist = bmMakeHuffman(new Array(32).fill(5));

  let last = false;
  while (!last) {
    last = get(1) === 1;
    const type = get(2);
    if (type === 0) { // stored
      hold = 0; bits = 0;
      const len = data[pos] | (data[pos + 1] << 8); pos += 4; // len + nlen
      for (let i = 0; i < len; i++) out.push(data[pos++]);
      continue;
    }
    let lit, dist;
    if (type === 1) { lit = fixedLit; dist = fixedDist; }
    else if (type === 2) {
      const HLIT = get(5) + 257, HDIST = get(5) + 1, HCLEN = get(4) + 4;
      const clLens = new Array(19).fill(0);
      for (let i = 0; i < HCLEN; i++) clLens[BM_CL_ORDER[i]] = get(3);
      const clDec = bmMakeHuffman(clLens);
      const lens = [];
      while (lens.length < HLIT + HDIST) {
        const s = clDec(getBit);
        if (s <= 15) lens.push(s);
        else if (s === 16) { const r = get(2) + 3, v = lens[lens.length - 1]; for (let i = 0; i < r; i++) lens.push(v); }
        else if (s === 17) { const r = get(3) + 3; for (let i = 0; i < r; i++) lens.push(0); }
        else { const r = get(7) + 11; for (let i = 0; i < r; i++) lens.push(0); }
      }
      lit = bmMakeHuffman(lens.slice(0, HLIT));
      dist = bmMakeHuffman(lens.slice(HLIT));
    } else throw new Error('bad deflate block type');
    for (;;) {
      const s = lit(getBit);
      if (s < 256) out.push(s);
      else if (s === 256) break;
      else {
        const li = s - 257;
        const len = BM_LBASE[li] + (BM_LEXT[li] ? get(BM_LEXT[li]) : 0);
        const ds = dist(getBit);
        const d = BM_DBASE[ds] + (BM_DEXT[ds] ? get(BM_DEXT[ds]) : 0);
        for (let i = 0; i < len; i++) out.push(out[out.length - d]);
      }
    }
  }
  return Uint8Array.from(out);
}

/* ---- minimal ZIP reader (just enough to extract named files) ---- */
function bmZipList(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = data.length;
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 65558); i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder('utf-8');
  const files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const exLen = dv.getUint16(p + 30, true);
    const coLen = dv.getUint16(p + 32, true);
    const lhOff = dv.getUint32(p + 42, true);
    const name = td.decode(data.subarray(p + 46, p + 46 + fnLen));
    files.push({ name: name, method: method, csize: csize, lhOff: lhOff });
    p += 46 + fnLen + exLen + coLen;
  }
  return files;
}

function bmZipExtract(data, entry) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const p = entry.lhOff;
  if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('bad zip local header');
  // NB: entries may use data descriptors (sizes zeroed in the local header);
  // the real sizes come from the central directory, and the descriptor bytes
  // sit after the data, so they can simply be ignored.
  const fnLen = dv.getUint16(p + 26, true);
  const exLen = dv.getUint16(p + 28, true);
  const start = p + 30 + fnLen + exLen;
  const comp = data.subarray(start, start + entry.csize);
  if (entry.method === 0) return comp.slice();
  if (entry.method === 8) return bmInflateRaw(comp);
  throw new Error('unsupported zip compression method ' + entry.method);
}

/* ---- minimal SQLite reader (just enough to scan one table) ---- */
function bmReadVarint(buf, pos) {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = buf[pos++];
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) return [v, pos];
  }
  v = v * 256 + buf[pos++];
  return [v, pos];
}
function bmReadInt(buf, p, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[p + i];
  const max = Math.pow(2, 8 * n - 1);
  return v >= max ? v - 2 * max : v;
}

// Parse one table-b-tree leaf/interior page set, calling onCell(payload) per row.
function bmSqliteScanTable(db, rootPage, onCell) {
  const dv = new DataView(db.buffer, db.byteOffset, db.byteLength);
  const pageSize = dv.getUint16(16) || 65536;
  const page = n => db.subarray((n - 1) * pageSize, n * pageSize);
  const walk = (pgNum, base) => {
    const pg = page(pgNum);
    const pv = new DataView(pg.buffer, pg.byteOffset, pg.byteLength);
    const type = pg[base];
    const ncell = pv.getUint16(base + 3);
    if (type === 0x05) { // interior table b-tree
      const right = pv.getUint32(base + 8);
      for (let i = 0; i < ncell; i++) {
        const cp = pv.getUint16(base + 12 + i * 2);
        walk(pv.getUint32(cp), 0);
      }
      walk(right, 0);
    } else if (type === 0x0d) { // leaf table b-tree
      const cps = [];
      for (let i = 0; i < ncell; i++) cps.push(pv.getUint16(base + 8 + i * 2));
      const X = pageSize - 35; // overflow threshold for table b-tree leaf cells
      for (const cp of cps) {
        let q = cp, r = bmReadVarint(pg, q);
        const payloadLen = r[0]; q = r[1];
        r = bmReadVarint(pg, q); q = r[1]; // rowid
        let payload;
        if (payloadLen <= X) {
          payload = pg.subarray(q, q + payloadLen);
        } else {
          // Overflowing cell: on-page bytes run to the next cell's start
          // (or the page end), with the last 4 bytes holding the next
          // overflow page number; the rest spills onto overflow pages.
          let cellEnd = pg.length;
          for (const cp2 of cps) if (cp2 > cp && cp2 < cellEnd) cellEnd = cp2;
          const firstLen = cellEnd - 4 - q;
          const out = [];
          for (let i = q; i < q + firstLen; i++) out.push(pg[i]);
          let next = pv.getUint32(cellEnd - 4);
          let remaining = payloadLen - firstLen;
          while (remaining > 0 && next) {
            const op = page(next);
            next = new DataView(op.buffer, op.byteOffset, op.byteLength).getUint32(0);
            const take = Math.min(remaining, op.length - 4);
            for (let i = 4; i < 4 + take; i++) out.push(op[i]);
            remaining -= take;
          }
          payload = Uint8Array.from(out);
        }
        onCell(payload);
      }
    } else throw new Error('unexpected sqlite page type ' + type);
  };
  walk(rootPage, rootPage === 1 ? 100 : 0);
}

function bmSqliteParseRecord(payload, td) {
  let r = bmReadVarint(payload, 0);
  const hend = r[0]; let p = r[1];
  const types = [];
  while (p < hend) { r = bmReadVarint(payload, p); types.push(r[0]); p = r[1]; }
  const vals = [];
  for (const t of types) {
    let v;
    if (t === 0) v = null;
    else if (t >= 1 && t <= 6) { v = bmReadInt(payload, p, [0, 1, 2, 3, 4, 6, 8][t]); p += [0, 1, 2, 3, 4, 6, 8][t]; }
    else if (t === 7) { v = new DataView(payload.buffer, payload.byteOffset + p, 8).getFloat64(0); p += 8; }
    else if (t === 8) v = 0;
    else if (t === 9) v = 1;
    else if (t >= 12 && t % 2 === 0) { const n = (t - 12) / 2; v = payload.subarray(p, p + n); p += n; }
    else if (t >= 13) { const n = (t - 13) / 2; v = td.decode(payload.subarray(p, p + n)); p += n; }
    else throw new Error('bad sqlite serial type ' + t);
    vals.push(v);
  }
  return vals;
}

// Returns [{ store, key, value, deleted }] for every row of the `entry` table.
function bmSqliteReadEntry(db) {
  const dv = new DataView(db.buffer, db.byteOffset, db.byteLength);
  let magic = '';
  for (let i = 0; i < 16; i++) magic += String.fromCharCode(db[i]);
  if (magic !== 'SQLite format 3\0') throw new Error('not a SQLite database');
  const enc = dv.getUint32(56);
  const td = new TextDecoder(enc === 1 ? 'utf-8' : enc === 2 ? 'utf-16le' : 'utf-16be');
  let entryRoot = 0;
  bmSqliteScanTable(db, 1, payload => {
    const cols = bmSqliteParseRecord(payload, td); // type, name, tbl_name, rootpage, sql
    if (cols[0] === 'table' && cols[1] === 'entry') entryRoot = cols[3];
  });
  if (!entryRoot) throw new Error('entry table not found');
  const rows = [];
  bmSqliteScanTable(db, entryRoot, payload => {
    const cols = bmSqliteParseRecord(payload, td); // id, store, key, value, deleted
    rows.push({
      store: cols[1],
      key: cols[2] instanceof Uint8Array ? td.decode(cols[2]) : String(cols[2]),
      value: cols[3],
      deleted: !!cols[4],
    });
  });
  return rows;
}

/* ---- Bookmory → app field mapping ---- */
const BM_STATUS = { DONE: 'read', NOT_STARTED: 'tbr', GIVE_UP: 'dnf', READING: 'reading' };
const BM_FAVORITE_COLLECTION = '1723808016228302'; // the "Favorite" collection id
function bmHalifaxDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function mapBookmoryBook(key, bm) {
  const status = BM_STATUS[(bm.status_list || [])[0]] || 'tbr';
  const total = Math.round(bm.real_total_page || bm.total_page || 0) || null;
  const isPercent = String(bm.page_type || '').toUpperCase() === 'PERCENT';
  const scale = p => isPercent && total ? Math.round(p / 100 * total) : Math.round(p || 0);
  const r0 = (bm.reads || [])[0] || {};
  const star = Math.max(0, Math.min(5, Math.round((+r0.star || 0) * 2) / 2));
  // page checkpoints → app daily log { d, from, to }, merged per day
  const logs = (r0.page_log_list || [])
    .map(e => ({ page: scale(e.page), at: +e.created_at || 0 }))
    .filter(e => e.at > 0)
    .sort((a, b) => a.at - b.at);
  const byDay = new Map();
  let prev = 0;
  for (const e of logs) {
    const d = bmHalifaxDate(e.at);
    const from = prev, to = Math.max(prev, e.page);
    prev = to;
    if (!byDay.has(d)) byDay.set(d, { d: d, from: from, to: to });
    else { const cur = byDay.get(d); cur.from = Math.min(cur.from, from); cur.to = Math.max(cur.to, to); }
  }
  const log = Array.from(byDay.values()).filter(e => e.to > e.from);
  const tags = String(bm.tags || '').split(/\s+/)
    .map(t => t.replace(/^#+/, '').trim()).filter(Boolean);
  const authors = (Array.isArray(bm.authors) && bm.authors.length ? bm.authors : (bm.author ? [bm.author] : []))
    .map(a => String(a).trim()).filter(Boolean);
  let pub = String(bm.publication_date || '').trim();
  const pm = pub.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  pub = pm ? pm[1] + '-' + pm[2].padStart(2, '0') + '-' + pm[3].padStart(2, '0') : '';
  const img = String(bm.image || '');
  return {
    id: 'bm-' + key, // stable id: re-imports update instead of duplicating
    isbn: cleanISBN(bm.isbn),
    title: String(bm.title || '').trim(),
    authors: authors,
    cover: /^https?:/i.test(img) ? img : '',
    _bmLocalImage: /^bookmory_data\//i.test(img) ? img.replace(/^bookmory_data\//i, '') : '',
    description: String(bm.description || ''),
    pageCount: total,
    publishedDate: pub,
    status: status,
    owned: 'owned', // the export carries no owned-vs-wanted signal
    myRating: star,
    tropes: Array.from(new Set(tags)),
    progress: status === 'read' && total ? total : (status === 'tbr' ? 0 : scale(bm.cur_page)),
    dateAdded: bm.created_at ? new Date(+bm.created_at).toISOString() : new Date().toISOString(),
    dateFinished: status === 'read' && bm.last_finished_read_date ? bmHalifaxDate(+bm.last_finished_read_date) : null,
    notes: String(r0.comment || ''),
    favorite: (bm.collection_keys || []).indexOf(BM_FAVORITE_COLLECTION) !== -1,
    series: null, // not in the export; Hardcover enrichment can fill it later
    log: log,
  };
}

// Unzip → SQLite → mapped books. Returns { books, zipData, imageEntries }.
function parseBookmoryExport(zipData) {
  const files = bmZipList(zipData);
  const dbEntry = files.find(f => f.name === 'new_bookmory.db' || f.name.endsWith('/new_bookmory.db'));
  if (!dbEntry) throw new Error('new_bookmory.db not found in the export');
  const db = bmZipExtract(zipData, dbEntry);
  const rows = bmSqliteReadEntry(db);
  const books = [];
  const skippedTitles = [];
  for (const row of rows) {
    if (row.store !== 'books' || row.deleted || !row.value) continue;
    const raw = String(row.value);
    try {
      // A rare record can carry raw control characters inside a string
      // (malformed JSON from the app); raw U+0000-U+001F are never valid
      // unescaped in JSON, so stripping them is a safe repair.
      const b = mapBookmoryBook(row.key, JSON.parse(raw.replace(/[\u0000-\u001F]/g, ' ')));
      if (b.title) { books.push(b); continue; }
    } catch (e) { /* fall through to the corruption report below */ }
    // Unsalvageable record (binary-corrupted JSON): report it by name so it
    // can be re-added by hand instead of silently vanishing.
    const tm = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    skippedTitles.push(tm ? tm[1].replace(/\\(.)/g, '$1') : 'a book with no readable title');
  }
  const imageEntries = files.filter(f => /^images\/books\//i.test(f.name) && !f.name.endsWith('/'));
  return { books: books, skippedTitles: skippedTitles, zipData: zipData, imageEntries: imageEntries };
}

// The export ships a few local cover photos; downscale them like profile
// photos so they stay small in localStorage. Best-effort: failures keep ''.
function bmDownscaleImageBytes(bytes) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    const img = new Image();
    img.onload = () => {
      try {
        const S = 256, scale = Math.min(1, S / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.82));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

async function bmAttachLocalCovers(zipData, imageEntries, books) {
  for (const b of books) {
    const local = b._bmLocalImage;
    delete b._bmLocalImage;
    if (!local) continue;
    const e = imageEntries.find(x => x.name === local);
    if (!e) continue;
    try {
      b.cover = await bmDownscaleImageBytes(bmZipExtract(zipData, e));
    } catch (err) { /* keep the placeholder */ }
  }
}

/* ---- import flow ---- */
async function handleBookmoryFile(file, mount) {
  mount.innerHTML = '<p class="note">Reading Bookmory export…</p>';
  track('import_started', { source: 'bookmory' });
  try {
    const zipData = new Uint8Array(await file.arrayBuffer());
    if (!(zipData[0] === 0x50 && zipData[1] === 0x4b)) throw new Error('not a zip file');
    const parsed = parseBookmoryExport(zipData);
    const books = parsed.books;
    if (!books.length) {
      mount.innerHTML = '<p class="note">No books found in this Bookmory export.</p>';
      track('import_failed', { source: 'bookmory' });
      return;
    }
    await bmAttachLocalCovers(parsed.zipData, parsed.imageEntries, books);
    const dupe = books.filter(b => b.title && (alreadyHave(b) || library.some(x => x.id === b.id))).length;
    const preview = books.slice(0, 5).map(b =>
      '<div class="result-card"><div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
      '<p class="author">' + esc(displayAuthors(b.authors) || 'Unknown author') + '</p></div></div>').join('');
    const corruptNote = parsed.skippedTitles.length
      ? '<p class="note">' + icon('warn') + ' ' + parsed.skippedTitles.length + ' record' +
        (parsed.skippedTitles.length === 1 ? ' was' : 's were') +
        ' corrupted inside the export and couldn\'t be read (' +
        parsed.skippedTitles.map(t => '“' + esc(t) + '”').join(', ') +
        ') — worth adding by hand.</p>'
      : '';
    mount.innerHTML =
      '<p class="note">Detected: <b>Bookmory</b> — ' + books.length + ' books' +
      (dupe ? ' (' + dupe + ' already on your shelves, will be skipped)' : '') + '</p>' +
      corruptNote + preview +
      (books.length > 5 ? '<p class="note">…and ' + (books.length - 5) + ' more</p>' : '') +
      '<button class="btn block" id="im-go">Import ' + books.length + ' books</button>' +
      '<p class="note">Statuses, ratings, page logs and favorites come along. ' +
      'Her written reading notes live only in the Bookmory app — they aren\'t in the export file.</p>';
    document.getElementById('im-go').addEventListener('click', () => {
      importBookmoryBooks(books, parsed.skippedTitles, mount && mount.id);
      mount.innerHTML = '';
    });
  } catch (e) {
    mount.innerHTML = '<p class="note">Couldn\'t read this Bookmory file (' + esc(e.message || 'unknown error') +
      '). Make sure it\'s the <b>Database.bookmory</b> backup from the app.</p>';
    track('import_failed', { source: 'bookmory' });
  }
}

// Add parsed books: stable bm- ids mean a second import of the same file
// updates the books in place instead of duplicating them. In-app-only data
// (spice ratings, her notes, Hardcover-enriched series) is never overwritten.
function importBookmoryBooks(books, skippedTitles, mountId) {
  let added = 0, updated = 0, skipped = 0;
  const fresh = [];
  for (const raw of books) {
    const existing = library.find(b => b.id === raw.id);
    if (existing) {
      const keepNotes = existing.notes, keepRatings = existing.ratings,
        keepAxes = existing.axes, keepSeries = existing.series;
      const b = migrateBook(Object.assign({}, raw));
      if (keepNotes) b.notes = keepNotes;
      if (keepRatings) b.ratings = keepRatings;
      if (keepAxes && keepAxes.length) b.axes = keepAxes;
      if (keepSeries) b.series = keepSeries;
      b._mtime = Date.now();
      Object.assign(existing, b);
      untombstone(existing.id);
      updated++;
      continue;
    }
    const b = migrateBook(Object.assign({
      cover: '', description: '', publishedDate: '', categories: [],
      publicRating: null, ratingsCount: 0, ratings: {}, axes: ['spice'],
      myRating: 0, progress: 0, dateFinished: null, notes: '',
      status: 'tbr', owned: 'owned', favorite: false,
    }, raw));
    if (!b.title || alreadyHave(b)) { skipped++; continue; }
    untombstone(b.id);
    fresh.push(b);
    added++;
  }
  for (let i = fresh.length - 1; i >= 0; i--) library.unshift(fresh[i]);
  saveLibrary();
  render();
  const bits = [added + ' added'];
  if (updated) bits.push(updated + ' updated');
  if (skipped) bits.push(skipped + ' already on shelves');
  if (skippedTitles && skippedTitles.length) bits.push(skippedTitles.length + ' corrupted in the export');
  // v224 (UX-14): summary banner in the hub instead of a vanishing toast.
  var bmMount = mountId ? document.getElementById(mountId) : null;
  if (bmMount) {
    bmMount.innerHTML = importDoneBannerHTML(bits.map(function(x) {
      return x.replace(' already on shelves', ' skipped');
    }));
    wireImportDoneBanner(bmMount);
  }
  track('import_completed', { source: 'bookmory', book_count: added });
  return { added: added, updated: updated, skipped: skipped };
}
