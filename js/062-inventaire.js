'use strict';

/* ---------------- Inventaire (inventaire.io) metadata source ----------------
   v244: Wikidata-centered CC0 book database — strong on French editions
   (it bootstraps editions from the BnF's own SPARQL endpoint by ISBN).
   Used in the ISBN-lookup waterfall between Google Books and Open Library.

   Requests go through the same-origin /api/inventaire proxy (Pages Function
   or server.py), which sets the identifying User-Agent Inventaire asks for
   (browsers cannot set User-Agent themselves). */

function invProxyUrl(query) {
  return '/api/inventaire/entities?' + query;
}

// Fetch entities by URI: 'isbn:978...' / 'wd:Q...' / 'inv:...'
// (pipe-separated for batching). Returns the raw { entities, redirects }.
async function invByUris(uris) {
  const r = await apiFetch(invProxyUrl('action=by-uris&uris=' + encodeURIComponent(uris)));
  return (await r.json()) || {};
}

function invClaims(entity) {
  return (entity && entity.claims) || {};
}
function invClaim(entity, prop) {
  const v = invClaims(entity)['wdt:' + prop];
  return v && v.length ? v[0] : null;
}
// Edition title: the P1476 (title) claim, else the fromclaims label.
function invTitle(entity) {
  return invClaim(entity, 'P1476') ||
    ((entity && entity.labels && entity.labels.fromclaims) || '');
}
// Display label for human entities (authors): names don't translate, so
// prefer French (the project's strong suit), then English, then anything.
function invLabel(entity) {
  const labels = (entity && entity.labels) || {};
  if (!labels || typeof labels !== 'object') return '';
  return labels.fr || labels.en || labels.fromclaims ||
    Object.keys(labels).map(k => labels[k]).find(v => typeof v === 'string' && v) || '';
}
function invCoverUrl(entity) {
  const u = entity && entity.image && entity.image.url;
  if (!u) return '';
  return u[0] === '/' ? 'https://inventaire.io' + u : u;
}

// Map an Inventaire edition entity (+ resolved author names) to the app's
// book shape, mirroring olDocToBook. No description or ratings exist on
// Inventaire — enrichRatings blends Open Library ratings in afterwards.
function invEditionToBook(edition, authorNames) {
  const rawIsbn = invClaim(edition, 'P212') || '';
  const isbn = String(rawIsbn).replace(/[^0-9X]/gi, '');
  const pages = invClaim(edition, 'P1104');
  const book = {
    id: uid(),
    isbn: isbn,
    title: invTitle(edition) || 'Unknown title',
    authors: authorNames || [],
    cover: invCoverUrl(edition),
    description: '',
    pageCount: pages != null && pages !== '' ? +pages : null,
    publishedDate: invClaim(edition, 'P577') || '',
    categories: [],
    publicRating: null,
    ratingsCount: 0,
    status: 'tbr',
    owned: 'owned',
    ratings: {},
    myRating: 0,
    tropes: [],
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: ''
  };
  book.axes = autoDetectAxes(book);
  return book;
}

// Resolve author names for a work entity: P50 author URIs → one batched
// by-uris call → labels.
async function invAuthorNames(work) {
  const authorUris = (invClaims(work)['wdt:P50'] || [])
    .filter(u => typeof u === 'string' && u);
  if (!authorUris.length) return [];
  try {
    const d = await invByUris(authorUris.join('|'));
    const entities = d.entities || {};
    return authorUris
      .map(u => entities[u] ? invLabel(entities[u]) : '')
      .filter(Boolean);
  } catch (e) { return []; }
}

// ISBN lookup via Inventaire: edition → work → authors (up to 3 fetches,
// all through the proxy). Returns a book shell or null.
async function invLookupISBN(isbn) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '');
  if (!clean) return null;
  const d = await invByUris('isbn:' + clean);
  const entities = d.entities || {};
  const redirects = d.redirects || {};
  const editionUri = redirects['isbn:' + clean];
  const edition = (editionUri && entities[editionUri]) || null;
  if (!edition) return null;
  let authorNames = [];
  const workUri = invClaim(edition, 'P629');
  if (workUri) {
    try {
      const wd = await invByUris(workUri);
      const work = (wd.entities || {})[workUri];
      if (work) authorNames = await invAuthorNames(work);
    } catch (e) { /* keep the edition data without authors */ }
  }
  return invEditionToBook(edition, authorNames);
}
