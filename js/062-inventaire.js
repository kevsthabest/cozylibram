'use strict';

/* js/062-inventaire.js — Inventaire (inventaire.io) metadata source.
 *
 * One source in the ISBN-lookup waterfall, between Google Books and
 * Open Library: given an ISBN, invLookupISBN() resolves edition → work
 * → authors through Inventaire's Wikidata-centered CC0 database, which
 * is strong on French editions (it bootstraps editions from the BnF's
 * own SPARQL endpoint by ISBN). The invClaim()/invTitle()/invLabel()
 * helpers read Wikidata-style claims (P1476 title, P212 ISBN, P577
 * date, P1104 pages, P629 work, P50 authors) off the raw entities.
 *
 * Every request goes through the same-origin /api/inventaire proxy
 * (Pages Function or server.py), never to inventaire.io directly: the
 * proxy sets the identifying User-Agent Inventaire asks for, and
 * browsers cannot set a User-Agent themselves.
 *
 * invEditionToBook() maps an edition entity into the app's book shape,
 * mirroring olDocToBook. Inventaire carries no description or ratings,
 * so those fields are born empty here; enrichRatings blends Open
 * Library ratings in afterwards.
 *
 * Surface: the inv* functions, exported and republished on window by
 * the bridge at the bottom of this file — js/061-gbooks-key.js and
 * js/080-pagecount.js still read them as globals (see ADR-003). This
 * file's own outbound reads are wired as real imports, below.
 */
import { apiFetch, uid } from './050-helpers.js';
import { autoDetectAxes } from './020-ratings.js';
export function invProxyUrl(query) {
  return '/api/inventaire/entities?' + query;
}

// Fetch entities by URI: 'isbn:978...' / 'wd:Q...' / 'inv:...'
// (pipe-separated for batching). Returns the raw { entities, redirects }.
export async function invByUris(uris) {
  const r = await apiFetch(invProxyUrl('action=by-uris&uris=' + encodeURIComponent(uris)));
  return (await r.json()) || {};
}

export function invClaims(entity) {
  return (entity && entity.claims) || {};
}
export function invClaim(entity, prop) {
  const v = invClaims(entity)['wdt:' + prop];
  return v && v.length ? v[0] : null;
}
// Edition title: the P1476 (title) claim, else the fromclaims label.
export function invTitle(entity) {
  return invClaim(entity, 'P1476') ||
    ((entity && entity.labels && entity.labels.fromclaims) || '');
}
// Display label for human entities (authors): names don't translate, so
// prefer French (the project's strong suit), then English, then anything.
export function invLabel(entity) {
  const labels = (entity && entity.labels) || {};
  if (!labels || typeof labels !== 'object') return '';
  return labels.fr || labels.en || labels.fromclaims ||
    Object.keys(labels).map(k => labels[k]).find(v => typeof v === 'string' && v) || '';
}
export function invCoverUrl(entity) {
  const u = entity && entity.image && entity.image.url;
  if (!u) return '';
  return u[0] === '/' ? 'https://inventaire.io' + u : u;
}

// Map an Inventaire edition entity (+ resolved author names) to the app's
// book shape, mirroring olDocToBook. No description or ratings exist on
// Inventaire — enrichRatings blends Open Library ratings in afterwards.
export function invEditionToBook(edition, authorNames) {
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
export async function invAuthorNames(work) {
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
export async function invLookupISBN(isbn) {
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

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers js/061-gbooks-key.js and js/080-pagecount.js call these helpers at runtime and still read them as globals, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups resolve through the global object, so the callers need no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last window-reading caller has wired the read as an import
   (ADR-003). */
window.invProxyUrl = invProxyUrl;
window.invByUris = invByUris;
window.invClaims = invClaims;
window.invClaim = invClaim;
window.invTitle = invTitle;
window.invLabel = invLabel;
window.invCoverUrl = invCoverUrl;
window.invEditionToBook = invEditionToBook;
window.invAuthorNames = invAuthorNames;
window.invLookupISBN = invLookupISBN;
