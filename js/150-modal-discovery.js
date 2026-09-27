'use strict';

/* ---- "missing books" discovery: more by author / full series from outside the library ---- */
const authorCache = new Map(); // author key -> external rows
const seriesCache = new Map(); // series key -> { rows } or { needsToken: true }

function normISBN(s) { return String(s || '').replace(/[^0-9X]/gi, ''); }

// true when an external result is already on her shelves (ISBN or title+author match)
function inLibrary(x) {
  const isbn = normISBN(x.isbn);
  const xt = String(x.title || '').trim().toLowerCase();
  const xa = String(x.author || '').trim().toLowerCase();
  return library.some(b => {
    if (isbn && normISBN(b.isbn) === isbn) return true;
    return !!xt && String(b.title || '').trim().toLowerCase() === xt &&
      String((b.authors || [])[0] || '').trim().toLowerCase() === xa;
  });
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

// More books by an author via Open Library (no key, no quota).
async function fetchMoreByAuthor(author) {
  const key = String(author).trim().toLowerCase();
  if (authorCache.has(key)) return authorCache.get(key);
  const url = 'https://openlibrary.org/search.json?author=' + encodeURIComponent(author) +
    '&limit=40&fields=key,title,author_name,isbn,cover_i';
  const d = await (await fetch(url)).json();
  const rows = dedupeExternal(((d || {}).docs || []).map(doc => ({
    title: doc.title || '',
    author: ((doc.author_name || [])[0]) || author,
    cover: doc.cover_i ? 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-M.jpg' : '',
    isbn: normISBN((doc.isbn || [])[0]),
    position: null,
    seriesName: null,
  // Skip omnibus/box-set editions ("Book A / Book B / ...") — clutter in an author list.
  })).filter(x => x.title && x.title.indexOf(' / ') === -1 && !inLibrary(x))).slice(0, 30);
  authorCache.set(key, rows);
  return rows;
}

// Every book in a series via Hardcover (needs the token).
async function fetchSeriesBooks(seriesName, authorName) {
  const key = String(seriesName).trim().toLowerCase();
  if (seriesCache.has(key)) return seriesCache.get(key);
  if (!hcToken()) { const r = { needsToken: true, rows: [] }; seriesCache.set(key, r); return r; }
  const seriesFields = 'id name author { name }' +
    ' book_series(distinct_on: position, order_by: [{position: asc}, {book: {users_count: desc}}],' +
    ' where: {compilation: {_eq: false}, book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}}}) {' +
    ' position details book { id title image { url } default_physical_edition { isbn_13 } } }';
  const qFor = pattern => 'query { series(where: {name: {_ilike: ' + JSON.stringify(pattern) +
    '}, books_count: {_gt: 0}, canonical_id: {_is_null: true}}, limit: 5) { ' + seriesFields + ' } }';
  const noData = () => { throw new Error('Hardcover returned no data — the token may be invalid or revoked.'); };
  let data = await hcGraphQL(qFor(seriesName));
  if (!data) noData();
  let list = data.series || [];
  if (!list.length) {
    // retry with a contains-match in case of minor name differences
    data = await hcGraphQL(qFor('%' + seriesName + '%'));
    if (!data) noData();
    list = data.series || [];
  }
  const want = String(authorName || '').trim().toLowerCase();
  const hit = list.find(s => want && String((s.author || {}).name || '').trim().toLowerCase() === want) || list[0];
  let rows = [];
  if (hit) {
    const sAuthor = (hit.author || {}).name || authorName || '';
    rows = dedupeExternal((hit.book_series || []).map(bs => {
      const bk = bs.book || {};
      const pos = parseFloat(bs.position);
      return {
        title: bk.title || '',
        author: sAuthor,
        cover: (bk.image || {}).url || '',
        isbn: normISBN((bk.default_physical_edition || {}).isbn_13),
        position: isNaN(pos) ? (bs.details || null) : (Number.isInteger(pos) ? pos : Math.round(pos * 10) / 10),
        seriesName: hit.name,
      };
    }).filter(x => x.title && !inLibrary(x)));
  }
  const out = { rows };
  seriesCache.set(key, out);
  return out;
}

// Add a discovered book straight to the wishlist (she doesn't own it yet).
function addExternalBook(x) {
  const book = {
    id: uid(),
    isbn: x.isbn || '',
    title: x.title,
    authors: x.author ? [x.author] : [],
    cover: x.cover || '',
    description: '',
    pageCount: null,
    publishedDate: '',
    categories: [],
    publicRating: null,
    ratingsCount: 0,
    status: 'tbr',
    owned: false, // discovered = wanted
    ratings: {},
    myRating: 0,
    tropes: [],
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: '',
    favorite: false,
    series: x.seriesName ? { name: x.seriesName, position: x.position } : null,
    log: [],
    _mtime: Date.now(),
  };
  book.axes = autoDetectAxes(book);
  library.unshift(book);
  saveLibrary();
  return book;
}

function externalRowHTML(x, i) {
  const sub = (x.position != null && x.position !== '' ? '#' + esc(String(x.position)) + ' · ' : '') +
    esc(x.author || 'Unknown author');
  return '<div class="crow ext" data-ext="' + i + '">' +
    (x.cover ? '<img src="' + esc(x.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
      : '<span class="cnocover">📕</span>') +
    '<span class="ctext"><b>' + esc(x.title) + '</b><small>' + sub + '</small></span>' +
    '<button class="btn small" data-extadd="' + i + '">+ Wishlist</button></div>';
}

/* ---- external book detail sheet (v60): tap a missing/discovered book to see
   its details. Enriches live via ISBN lookup (Google Books → Open Library),
   falling back to a title+author search when there is no ISBN. ---- */
function openExternalDetail(x) {
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  const sub = (x.position != null && x.position !== '' ? '#' + esc(String(x.position)) + ' · ' : '') +
    (x.seriesName ? esc(x.seriesName) + ' · ' : '') + esc(x.author || 'Unknown author');
  ov.innerHTML =
    '<div class="modal-backdrop" id="x-back" style="z-index:80"><div class="modal" role="dialog">' +
    '<button class="modal-close" id="x-x">✕</button>' +
    '<div class="ext-detail">' +
    (x.cover ? '<img class="ext-cover" src="' + esc(x.cover) + '" alt="" onerror="this.remove()">'
      : '<div class="ext-nocover">📕</div>') +
    '<h2 class="serif">' + esc(x.title) + '</h2>' +
    '<p class="note">' + sub + '</p>' +
    '<div id="x-meta"><p class="note">Looking up details…</p></div>' +
    '<div id="x-desc"></div>' +
    '<button class="btn" id="x-wish" style="width:100%;margin-top:14px">💝 + Wishlist</button>' +
    '</div></div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#x-back').addEventListener('click', e => { if (e.target.id === 'x-back') close(); });
  ov.querySelector('#x-x').addEventListener('click', close);
  let added = false;
  ov.querySelector('#x-wish').addEventListener('click', () => {
    if (added) return;
    added = true;
    addEnrichedToWishlist(x, ov._full);
    const btn = ov.querySelector('#x-wish');
    if (btn) btn.outerHTML = '<p class="note" style="text-align:center">💝 In your wishlist</p>';
    toast('Added to wishlist 💝');
  });
  // enrich in the background; the sheet stays usable meanwhile
  (async () => {
    let full = null;
    try {
      if (x.isbn) full = await lookupISBN(x.isbn);
      if (!full) {
        const res = await searchBooks((x.title || '') + ' ' + (x.author || ''));
        const nt = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        full = ((res || []).find(r => nt(r.title) === nt(x.title)) || (res || [])[0]) || null;
      }
    } catch (e) { /* show what we have */ }
    ov._full = full;
    const metaBox = ov.querySelector('#x-meta');
    if (!metaBox) return; // sheet was closed already
    if (!full) {
      metaBox.innerHTML = '<p class="note">Couldn\'t pull full details for this one.</p>';
      return;
    }
    const bits = [];
    if (full.pageCount) bits.push(full.pageCount + ' pages');
    const yr = String(full.publishedDate || '').slice(0, 4);
    if (/^\d{4}$/.test(yr)) bits.push(yr);
    if (full.publicRating) bits.push('★ ' + full.publicRating +
      (full.ratingsCount ? ' (' + full.ratingsCount + ')' : ''));
    metaBox.innerHTML = bits.length
      ? '<p class="ext-bits">' + bits.map(esc).join(' · ') + '</p>' : '';
    if (full.description) {
      const d = ov.querySelector('#x-desc');
      if (d) d.innerHTML = '<p class="ext-desc">' + esc(full.description) + '</p>';
    }
    const img = ov.querySelector('.ext-cover');
    if (full.cover && img && img.getAttribute('src') !== full.cover) img.src = full.cover;
  })();
}

// Add an external book to the wishlist, keeping any enriched metadata.
function addEnrichedToWishlist(x, full) {
  const ex = {
    title: (full && full.title) || x.title,
    author: ((full && full.authors && full.authors[0]) || x.author || ''),
    cover: (full && full.cover) || x.cover || '',
    isbn: (full && full.isbn) || x.isbn || '',
    position: x.position != null ? x.position
      : (full && full.series && full.series.position),
    seriesName: x.seriesName || (full && full.series && full.series.name) || null,
  };
  const book = addExternalBook(ex);
  if (full) {
    if (full.description) book.description = full.description;
    if (full.pageCount) book.pageCount = full.pageCount;
    if (full.publishedDate) book.publishedDate = full.publishedDate;
    if (full.categories && full.categories.length) book.categories = full.categories;
    if (full.publicRating) {
      book.publicRating = full.publicRating;
      book.ratingsCount = full.ratingsCount || 0;
    }
    book.axes = autoDetectAxes(book);
    saveLibrary();
  }
  return book;
}

// Fill the "more books" section of the collection sheet (async, after it opens).
async function fillMoreSection(kind, name, fromId, ov) {
  const box = ov.querySelector('#c-more');
  if (!box) return;
  const heading = kind === 'author' ? '🔍 More by ' + name : '🔍 Every book in this series';
  try {
    let rows;
    if (kind === 'author') {
      rows = await fetchMoreByAuthor(name);
    } else {
      const from = library.find(b => b.id === fromId);
      const r = await fetchSeriesBooks(name, from && from.authors[0]);
      if (r.needsToken) {
        box.innerHTML = '<h3 class="serif c-more-h">' + esc(heading) + '</h3>' +
          '<p class="note">💡 Connect Hardcover in Settings to see every book in this series.</p>';
        return;
      }
      rows = r.rows;
    }
    if (!rows.length) {
      box.innerHTML = '<h3 class="serif c-more-h">' + esc(heading) + '</h3>' +
        '<p class="note">Nothing missing — nice shelf! 🎉</p>';
      return;
    }
    box.innerHTML = '<h3 class="serif c-more-h">' + esc(heading) + '</h3>' +
      '<div class="collection-list">' + rows.map(externalRowHTML).join('') + '</div>';
    box.querySelectorAll('[data-extadd]').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addExternalBook(rows[Number(btn.dataset.extadd)]);
        btn.outerHTML = '<span class="c-added">💝 In wishlist</span>';
        toast('Added to wishlist 💝');
      }));
    // v60: tapping the row itself opens the detail sheet
    box.querySelectorAll('[data-ext]').forEach(row =>
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-extadd]')) return;
        openExternalDetail(rows[Number(row.dataset.ext)]);
      }));
  } catch (e) {
    const hint = kind === 'series'
      ? 'Couldn\'t reach Hardcover — if this keeps happening, check the token in Settings → Hardcover.'
      : 'Couldn\'t look up more books right now.';
    box.innerHTML = '<h3 class="serif c-more-h">' + esc(heading) + '</h3>' +
      '<p class="note">' + hint + '</p>';
  }
}

function openCollection(kind, name, fromId) {
  const key = String(name).trim().toLowerCase();
  const match = b => kind === 'author'
    ? (b.authors || []).some(a => String(a).trim().toLowerCase() === key)
    : (b.series && b.series.name && String(b.series.name).trim().toLowerCase() === key);
  const others = library.filter(b => b.id !== fromId && match(b));
  others.sort((a, b) => {
    if (kind === 'series') {
      const pa = parseFloat(a.series && a.series.position), pb = parseFloat(b.series && b.series.position);
      const d = (isNaN(pa) ? 1e9 : pa) - (isNaN(pb) ? 1e9 : pb);
      if (d) return d;
    }
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="c-back" style="z-index:70"><div class="modal" role="dialog">' +
    '<button class="modal-close" id="c-x">✕</button>' +
    '<h2 class="serif" style="margin-top:0">' + (kind === 'author' ? '✍️ ' : '📚 ') + esc(name) + '</h2>' +
    '<p class="note">' + others.length + ' other book' + (others.length === 1 ? '' : 's') + ' on your shelves</p>' +
    (others.length
      ? '<div class="collection-list">' + others.map(collectionRowHTML).join('') + '</div>'
      : '<p class="note">Nothing else here yet — this is the only one.</p>') +
    '<div id="c-more"><p class="note">Looking for more books…</p></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#c-back').addEventListener('click', e => { if (e.target.id === 'c-back') close(); });
  ov.querySelector('#c-x').addEventListener('click', close);
  ov.querySelectorAll('[data-book]').forEach(el =>
    el.addEventListener('click', () => {
      const r = el.getBoundingClientRect(); // capture before close() detaches it
      close();
      openDetail(el.dataset.book, { fromRect: r });
    }));
  fillMoreSection(kind, name, fromId, ov);
}

/* ---- book-opening transition: the tapped cover flies to center, then swings
   open like a real book cover, revealing the detail modal behind it ---- */
function bookCoverFaceHTML(b) {
  if (b.cover) return '<img src="' + esc(b.cover) + '" alt="">';
  const c = (typeof spineColorCache !== 'undefined' && spineColorCache[b.id] && spineColorCache[b.id].hex) ||
    SPINE_COLORS[hashStr(b.title || '?') % SPINE_COLORS.length];
  return '<div class="bo-nocover" style="background:' + c + '"><span>📖</span><b>' +
    esc(b.title || 'Untitled') + '</b></div>';
}
// from: element or rect the cover starts from. dropEl: removed in the same
// frame (used by the spine pull-out so its popped cover swaps seamlessly).
function playBookOpen(b, from, dropEl, done) {
  const r = from && from.getBoundingClientRect ? from.getBoundingClientRect() : from;
  const vw = window.innerWidth || 360, vh = window.innerHeight || 640;
  const bw = Math.min(230, vw * 0.62), bh = bw * 1.5;
  const cx = (vw - bw) / 2, cy = Math.max(8, (vh - bh) / 2 - 24);
  const start = (r && r.width > 4)
    ? 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'
    : 'left:' + cx + 'px;top:' + cy + 'px;width:' + bw + 'px;height:' + bh + 'px';
  const ov = document.createElement('div');
  ov.className = 'bookopen-overlay';
  ov.innerHTML =
    '<div class="bookopen-backdrop"></div>' +
    '<div class="bookopen-stage" style="' + start + '">' +
      '<div class="bookopen-book">' +
        '<div class="bookopen-pages"><div class="bop-title">' + esc(b.title || 'Untitled') + '</div>' +
        '<div class="bop-lines"></div></div>' +
        '<div class="bookopen-cover">' + bookCoverFaceHTML(b) + '</div>' +
      '</div></div>';
  if (dropEl && dropEl.remove) dropEl.remove();
  document.body.appendChild(ov);
  const stage = ov.querySelector('.bookopen-stage');
  const book = ov.querySelector('.bookopen-book');
  const raf = window.requestAnimationFrame || (fn => setTimeout(fn, 16));
  raf(() => raf(() => {
    ov.classList.add('lit');
    stage.style.left = cx + 'px'; stage.style.top = cy + 'px';
    stage.style.width = bw + 'px'; stage.style.height = bh + 'px';
  }));
  const FLY = 400, FLIP = 750;
  setTimeout(() => book.classList.add('open'), FLY);
  setTimeout(() => { done(); ov.classList.add('gone'); }, FLY + Math.round(FLIP * 0.55));
  setTimeout(() => ov.remove(), FLY + Math.round(FLIP * 0.55) + 450);
}
// Open a book's detail modal, playing the book-opening transition when the
// call site has a cover element (or rect) to start from and motion is allowed.
function openBookFromEl(el, id) {
  openDetail(id, el ? { fromEl: el } : null);
}
function openDetail(id, opts) {
  const b = library.find(x => x.id === id);
  if (!b) return;
  const from = opts && (opts.fromEl || opts.fromRect);
  if (from && !reducedMotion()) {
    playBookOpen(b, from, opts.dropEl, () => renderDetailModal(b, true));
  } else {
    if (opts && opts.dropEl && opts.dropEl.remove) opts.dropEl.remove();
    renderDetailModal(b, false);
  }
}
function renderDetailModal(b, viaBook) {
  const id = b.id;
  editingId = id;
  const root = document.getElementById('modal-root');

  const segBtns = Object.keys(STATUS).map(s =>
    '<button data-s="' + s + '" class="' + (b.status === s ? 'active' : '') + '">' +
    ({ tbr: '📖 TBR', reading: '📘 Reading', read: '✅ Read', dnf: '🚫 DNF' })[s] + '</button>').join('');

  const hearts = [1, 2, 3, 4, 5].map(n =>
    '<button data-v="' + n + '" class="' + (b.myRating >= n ? 'on' : '') + '">❤️</button>').join('');

  // draft copy the controls edit until Save
  const draft = Object.assign({}, b, {
    tropes: (b.tropes || []).slice(),
    ratings: Object.assign({}, b.ratings),
    axes: (b.axes || []).slice()
  });
  if (!draft.axes.length) draft.axes = autoDetectAxes(draft);
  editingDraft = draft;

  // v67: previously-read default from history — a finish older than 60 days
  // means she read it before tracking, so don't stamp or log today.
  if (draft.previouslyRead == null) {
    draft.previouslyRead = !!(draft.dateFinished && Date.now() - new Date(draft.dateFinished).getTime() > 60 * 864e5);
  }
  const startProgress = draft.progress || 0; // v67: only genuine progress edits log pages

  // rating-type toggle chips + per-axis emoji pickers
  const axRowsHTML = () => draft.axes.map(k => {
    const a = axisByKey(k);
    const v = draft.ratings[k] || 0;
    const btns = [1, 2, 3, 4, 5].map(n =>
      '<button data-v="' + n + '" class="' + (v >= n ? 'on' : '') + '">' + a.emoji + '</button>').join('');
    return '<div class="axrow"><span>' + a.emoji + ' ' + a.label + '</span>' +
      '<div class="picker" data-ax="' + k + '">' + btns + '</div></div>';
  }).join('');
  const axChipsHTML = RATING_AXES.map(a =>
    '<button class="chip' + (draft.axes.includes(a.key) ? ' active' : '') + '" data-axchip="' + a.key + '">' +
    a.emoji + ' ' + a.label + '</button>').join('');

  // Quick page tracker for books being read: steppers save immediately.
  const progressQuickHTML = () => {
    if (draft.status !== 'reading') return '';
    const total = draft.pageCount || 0;
    const cur = total ? Math.min(draft.progress || 0, total) : (draft.progress || 0);
    const pct = total ? Math.round(cur / total * 100) : 0;
    return '<div class="field"><label>Reading progress</label>' +
      '<div class="progress-line big"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<p class="pq-label">' + (total
        ? 'Page <b>' + cur + '</b> of ' + total + ' · ' + pct + '%'
        : 'Page <b>' + cur + '</b> — set total pages below to see %') + '</p>' +
      '<div class="stepper-row">' +
      ['−10', '−1', '+1', '+10'].map(d =>
        '<button class="btn ghost step" data-step="' + d.replace('−', '-') + '">' + d + '</button>').join('') +
      '</div></div>';
  };
  const renderProgressSection = () => {
    const el = document.getElementById('m-progress');
    if (!el) return;
    el.innerHTML = progressQuickHTML();
    el.querySelectorAll('[data-step]').forEach(btn =>
      btn.addEventListener('click', () => {
        const total = draft.pageCount || 0;
        const oldP = draft.progress || 0;
        const next = oldP + Number(btn.dataset.step);
        draft.progress = total ? Math.max(0, Math.min(total, next)) : Math.max(0, next);
        logPages(b, oldP, draft.progress);
        draft.log = b.log; // logPages may have created the array on b
        b.progress = draft.progress; // immediate save — no need to hit Save
        saveLibrary();
        const inp = document.getElementById('f-progress');
        if (inp) inp.value = draft.progress;
        renderProgressSection();
      }));
  };
  refreshProgressSection = renderProgressSection;

  root.innerHTML =
    '<div class="modal-backdrop' + (viaBook ? ' from-book' : '') + '" id="m-back"><div class="modal" role="dialog">' +
    '<button class="modal-close" id="m-x">✕</button>' +
    '<div class="modal-head"><div class="mcover-col">' + coverHTML(b) +
    '<button class="btn ghost sm" id="m-changecover" title="Choose a different cover">🖼️</button></div>' +
    '<div><h2>' + esc(b.title) + '</h2>' +
    '<p class="author">' + ((b.authors && b.authors.length)
      ? b.authors.map(a => '<button class="taplink" data-author="' + esc(a) + '">' + esc(a) + '</button>').join(', ')
      : 'Unknown author') + '</p>' +
    (b.publicRating ? '<div class="pub-rating">Public: ' + stars(b.publicRating) + ' · ' + b.ratingsCount + ' ratings</div>' : '<div class="pub-rating">No public rating found</div>') +
    (b.pageCount ? '<div class="pub-rating">' + b.pageCount + ' pages' + (b.publishedDate ? ' · ' + esc(b.publishedDate.slice(0, 4)) : '') + '</div>' : '') +
    '</div>' +
    '<button class="fav-btn' + (draft.favorite ? ' on' : '') + '" id="f-fav" aria-label="Toggle favorite">' + (draft.favorite ? '❤️' : '🤍') + '</button></div>' +
    (b.description ? '<div class="desc">' + b.description + '</div>' : '') +
    '<div id="m-hc">' + hcDetailHTML(b) + '</div>' +
    '<div id="m-progress"></div>' +

    '<div class="field"><label>Shelf</label><div class="seg" id="f-status">' + segBtns + '</div>' +
    '<label class="checkline" id="f-prevwrap" style="' + (draft.status === 'read' ? '' : 'display:none') + '">' +
    '<input type="checkbox" id="f-prevread"' + (draft.previouslyRead ? ' checked' : '') + '> 📜 Previously read' +
    '<span class="chk-hint">read before tracking — no date stamp, no log</span></label></div>' +

    '<div class="field"><label>Ownership</label><div class="seg" id="f-owned" style="grid-template-columns:1fr 1fr">' +
    '<button data-o="1" class="' + (draft.owned ? 'active' : '') + '">🏠 Owned</button>' +
    '<button data-o="0" class="' + (!draft.owned ? 'active' : '') + '">🛒 To buy</button></div></div>' +

    '<div class="field" id="m-buywrap" style="display:' + (draft.owned ? 'none' : '') + '">' +
    '<label>Where to buy <span class="note-inline">· ' + esc(STORE_REGIONS[detectStoreRegion()].label) + '</span></label>' +
    '<div class="buy-row">' + storeLinks(draft).map(l =>
      '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(l.url) + '">' + esc(l.name) + ' ↗</a>').join('') +
    '</div></div>' +

    '<div class="field"><label>Ratings</label>' +
    '<div class="chips" id="f-axes">' + axChipsHTML + '</div>' +
    '<div id="f-axrows">' + axRowsHTML() + '</div></div>' +
    '<div class="field"><label>My rating</label><div class="picker" id="f-myrating">' + hearts + '</div></div>' +

    '<div class="field"><label>Tropes (comma separated)</label>' +
    '<input id="f-tropes" class="text-input" placeholder="enemies to lovers, forced proximity…" value="' + esc(b.tropes.join(', ')) + '"></div>' +

    '<div class="field"><label>Total pages</label>' +
    '<div class="row-flex"><input id="f-pagecount" class="text-input" type="number" min="0" inputmode="numeric" placeholder="e.g. 384" value="' + (draft.pageCount || '') + '">' +
    (b.isbn ? '<button class="btn ghost" id="pc-lookup" title="Look up page count by ISBN">🔍</button>' : '') + '</div></div>' +
    '<div class="field"><label>Current page</label>' +
    '<input id="f-progress" class="text-input" type="number" min="0" inputmode="numeric" value="' + (draft.progress || 0) + '"></div>' +

    '<div class="field"><label>My notes</label>' +
    '<textarea id="f-notes" class="text-input" placeholder="Thoughts, quotes, warnings for future self…">' + esc(b.notes) + '</textarea></div>' +

    '<div class="modal-actions"><button class="btn ghost" id="m-del">Remove</button>' +
    '<button class="btn" id="m-save">Save</button></div>' +
    '</div></div>';

  // wire controls (work on the draft copy until Save)
  const wireAxRows = () => {
    root.querySelectorAll('#f-axrows [data-ax]').forEach(row => {
      const k = row.dataset.ax;
      row.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
        const v = Number(btn.dataset.v);
        draft.ratings[k] = (draft.ratings[k] === v) ? 0 : v; // tap again to clear
        row.querySelectorAll('button').forEach((x, i) =>
          x.classList.toggle('on', i < draft.ratings[k]));
      }));
    });
  };

  root.querySelectorAll('#f-status button').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.status = btn.dataset.s;
      root.querySelectorAll('#f-status button').forEach(x => x.classList.toggle('active', x === btn));
      const pv = document.getElementById('f-prevwrap');
      if (pv) pv.style.display = draft.status === 'read' ? '' : 'none';
      if (draft.status === 'read' && !draft.dateFinished && !draft.previouslyRead) draft.dateFinished = new Date().toISOString();
      if (draft.status !== 'read') draft.dateFinished = null;
      if (draft.status === 'read' && draft.pageCount && !draft.previouslyRead) {
        draft.progress = draft.pageCount; // Save logs the completion delta
        const pi = document.getElementById('f-progress');
        if (pi) pi.value = draft.progress;
      }
      renderProgressSection();
    }));

  document.getElementById('f-prevread').addEventListener('change', e => {
    draft.previouslyRead = e.target.checked;
    const pi = document.getElementById('f-progress');
    if (draft.previouslyRead) {
      if (draft.dateFinished && !b.dateFinished) draft.dateFinished = null; // undo today's stamp
      draft.progress = startProgress; // undo the auto completion bump
      if (pi) pi.value = draft.progress;
    } else if (draft.status === 'read' && !draft.dateFinished) {
      draft.dateFinished = new Date().toISOString();
      if (draft.pageCount) {
        draft.progress = draft.pageCount;
        if (pi) pi.value = draft.progress;
      }
    }
  });

  root.querySelectorAll('#f-owned button').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.owned = btn.dataset.o === '1';
      root.querySelectorAll('#f-owned button').forEach(x => x.classList.toggle('active', x === btn));
      const bw = document.getElementById('m-buywrap');
      if (bw) bw.style.display = draft.owned ? 'none' : '';
    }));

  const wirePicker = (sel, key) => {
    root.querySelectorAll(sel + ' button').forEach(btn =>
      btn.addEventListener('click', () => {
        const v = Number(btn.dataset.v);
        draft[key] = (draft[key] === v) ? 0 : v; // tap again to clear
        root.querySelectorAll(sel + ' button').forEach((x, i) =>
          x.classList.toggle('on', i < draft[key]));
      }));
  };
  wirePicker('#f-myrating', 'myRating');
  wireAxRows();

  root.querySelectorAll('#f-axes [data-axchip]').forEach(c => c.addEventListener('click', () => {
    const k = c.dataset.axchip;
    if (draft.axes.includes(k)) {
      draft.axes = draft.axes.filter(x => x !== k);
      delete draft.ratings[k];
    } else {
      draft.axes = draft.axes.concat(k);
    }
    c.classList.toggle('active');
    document.getElementById('f-axrows').innerHTML = axRowsHTML();
    wireAxRows();
  }));

  const close = () => { root.innerHTML = ''; editingId = null; editingDraft = null; refreshProgressSection = null; };
  document.getElementById('m-x').addEventListener('click', close);
  document.getElementById('m-changecover').addEventListener('click', () => openCoverPicker(id));
  document.getElementById('m-back').addEventListener('click', e => { if (e.target.id === 'm-back') close(); });
  root.querySelectorAll('[data-author]').forEach(el =>
    el.addEventListener('click', () => openCollection('author', el.dataset.author, id)));
  root.querySelectorAll('[data-series]').forEach(el =>
    el.addEventListener('click', () => openCollection('series', el.dataset.series, id)));
  renderProgressSection();

  document.getElementById('f-fav').addEventListener('click', () => {
    draft.favorite = !draft.favorite;
    b.favorite = draft.favorite; // immediate — no need to hit Save
    saveLibrary();
    const fb = document.getElementById('f-fav');
    fb.textContent = draft.favorite ? '❤️' : '🤍';
    fb.classList.toggle('on', draft.favorite);
    render(); // refresh the shelf behind the modal
    toast(draft.favorite ? 'Pinned to favorites ❤️' : 'Removed from favorites 🤍');
  });

  const lk = document.getElementById('pc-lookup');
  if (lk) lk.addEventListener('click', async () => {
    lk.disabled = true; lk.textContent = '…';
    const n = await fetchPageCountByISBN(b.isbn);
    lk.disabled = false; lk.textContent = '🔍';
    if (n) {
      draft.pageCount = n;
      document.getElementById('f-pagecount').value = n;
      renderProgressSection();
      toast('📄 Found: ' + n + ' pages');
    } else toast('No page count found for this ISBN');
  });

  document.getElementById('m-save').addEventListener('click', () => {
    draft.tropes = document.getElementById('f-tropes').value.split(',')
      .map(t => t.trim().toLowerCase()).filter(Boolean);
    draft.notes = document.getElementById('f-notes').value;
    draft.previouslyRead = document.getElementById('f-prevread').checked;
    const totalEl = document.getElementById('f-pagecount');
    draft.pageCount = Math.max(0, Number(totalEl.value) || 0) || null;
    const prog = document.getElementById('f-progress');
    const cap = draft.pageCount || Infinity;
    const enteredProg = Math.max(0, Number(prog.value) || 0);
    // v67: only a genuine change to the progress field logs pages — fixing the
    // total (which can clamp progress) no longer fabricates a reading session,
    // and previously-read books never log.
    if (!draft.previouslyRead && enteredProg !== startProgress) logPages(b, startProgress, enteredProg);
    draft.progress = Math.min(cap, enteredProg);
    if (!draft.title.trim()) draft.title = 'Untitled';
    draft.log = b.log;
    Object.assign(b, draft);
    saveLibrary(); close(); render();
    toast('Saved ✨');
  });

  document.getElementById('m-del').addEventListener('click', () => {
    if (!confirm('Remove "' + b.title + '" from your shelves?')) return;
    removeBook(id);
    close(); render();
    toast('Removed');
  });
}

