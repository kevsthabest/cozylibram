'use strict';

/* ---------------- Gift a Book (v582) ----------------
 * Wishlist purchasing & gifting (spec: docs/gift-purchase-spec.md).
 * The app never becomes a store: retailer links are plain,
 * tagless search URLs built from the ISBN-13, and everything social
 * — who may gift whom, which books are claimed, whose address may
 * be revealed — is decided server-side by the SECURITY DEFINER
 * RPCs in supabase/migrations/v582_gift_a_book.sql. This module is
 * presentation only:
 *
 * - Grants (gift_grants) are per-(recipient, friend) and default
 *   OFF; without one, no Gift action, no claim state, nothing —
 *   the friend's wishlist renders exactly as it did before.
 * - A Gift tap creates the claim silently (gift_claim), then the
 *   "Send this gift" sheet asks gift_address_reveal for the
 *   delivery details. EVERY refusal comes back as the same empty
 *   object and renders as the same single line (spec A10):
 *   "Delivery details aren't shared for this gift." The client
 *   never learns — and never hints — which predicate refused.
 * - The recipient sees nothing about claims anywhere unless they
 *   turn on "See claims on my wishlist" (profiles.gift_claims_visible,
 *   Settings → Circle & privacy); the dedicated recipient RPC is
 *   the only read path and it exists only behind that setting.
 * - Pre-migration the column/RPCs don't exist: error shapes latch
 *   a module-level "unsupported" flag and every gift surface fails
 *   quiet — nothing renders (fail closed, the Marginalia pattern).
 */

let giftTableMissing = false;   // gifts pre-migration
let giftSupportKnown = null;    // probe cache: true / false / null
const GIFT_RETAILERS_KEY = 'cozylibram.giftretailers';
const GIFT_CLAIMS_LOCAL_KEY = 'cozylibram.giftclaims.local';
const GIFT_NO_DETAILS_LINE = 'Delivery details aren\'t shared for this gift.';

function giftLog() {
  if (window.AppLog && AppLog.info) AppLog.info.apply(AppLog, ['[gifts]'].concat([].slice.call(arguments)));
}
function giftMissingErr(e) {
  if (!e) return false;
  const msg = String((e && e.message) || e || '');
  const code = String((e && e.code) || '');
  return /(gift_|gift_claims_visible|gift_grants)/i.test(msg) &&
    (code === '42703' || code === '42P01' || code === 'PGRST202' || code === 'PGRST204' ||
     code === 'PGRST205' || code === '42883' ||
     /schema cache|does not exist|not found/i.test(msg));
}
function giftLatchIfMissing(e) {
  if (giftMissingErr(e)) { giftTableMissing = true; giftSupportKnown = false; return true; }
  return false;
}

/* Support probe: the profiles column is the migration's footprint
 * (the claim/address tables are policy-closed by design, so a
 * table probe can't distinguish missing from locked). */
async function giftSupported() {
  if (giftTableMissing) return false;
  if (giftSupportKnown !== null) return giftSupportKnown;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return false;
    const r = await sb.from('profiles').select('gift_claims_visible').eq('user_id', cloudUser.id).maybeSingle();
    if (r.error) {
      if (giftMissingErr(r.error)) { giftTableMissing = true; giftSupportKnown = false; }
      else giftLog('support probe failed:', (r.error && r.error.message) || r.error);
      return giftSupportKnown === true;
    }
    giftSupportKnown = true;
    return true;
  } catch (e) { giftLog('support probe threw', e); return false; }
}

/* One RPC door: null on any failure (missing machinery latches
 * unsupported; anything else is logged and reads as "nothing"). */
async function giftRpc(name, args) {
  if (giftTableMissing) return null;
  try {
    const sb = await cloudClient();
    if (!sb || !cloudUser) return null;
    const r = await sb.rpc(name, args || {});
    if (r.error) {
      if (!giftLatchIfMissing(r.error)) giftLog(name + ' failed:', (r.error && r.error.message) || r.error);
      return null;
    }
    return r.data;
  } catch (e) { giftLog(name + ' threw', e); return null; }
}

/* ---------- the book key (client mirror of the server's
 * marginalia_book_key — writer and viewer must agree exactly) ---------- */

/* ISBN-13 normalization: 13 digits pass through; a 10-char ISBN is
 * converted ('978' + first 9 + recomputed check digit); anything
 * else is no ISBN. */
function giftIsbn13(raw) {
  const v = String(raw == null ? '' : raw).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (v.length === 13) return v;
  if (v.length !== 10) return '';
  const v12 = '978' + v.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(v12.charAt(i)) * (i % 2 === 0 ? 1 : 3);
  return v12 + String((10 - (sum % 10)) % 10);
}
function giftBookKey(book) {
  if (!book) return '';
  const d = (book.data && typeof book.data === 'object') ? book.data : book;
  const isbn = giftIsbn13((d.isbn != null && d.isbn !== '') ? d.isbn : book.isbn);
  if (isbn) return 'isbn:' + isbn;
  const title = String((d.title != null ? d.title : book.title) || '').trim().toLowerCase();
  const a = (d.authors != null ? d.authors : book.authors);
  let first = '';
  if (Array.isArray(a)) first = a[0] || '';
  else if (typeof a === 'string') first = a;
  return 'ta:' + title + '|' + String(first).trim().toLowerCase();
}
/* Human label for a key when no local copy names it (the
 * marginalia titleFor fallback shape). */
function giftKeyLabel(key) {
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  const mine = lib.find(b => b && giftBookKey(b) === key);
  if (mine) return mine.title || 'Untitled';
  if (key && key.indexOf('ta:') === 0) return key.slice(3).split('|')[0] || 'A book';
  return 'A book';
}

/* ---------- format kinds + retailer links (spec §5) ----------
 * The link builder is the single place retailer URLs are composed.
 * Links are plain search URLs — no tags, no tracking parameters,
 * no referral codes, no prices, ever. */
function giftFormatKind(fmt) {
  return fmt === 'ebook' ? 'ebook' : fmt === 'audio' ? 'audio' : 'print';
}
const GIFT_RETAILERS = {
  indigo: { label: 'Indigo', build: q => 'https://www.indigo.ca/en-ca/search?q=' + q },
  amazon: { label: 'Amazon.ca', build: q => 'https://www.amazon.ca/s?k=' + q },
  kobo:   { label: 'Kobo', build: q => 'https://www.kobo.com/ca/en/search?query=' + q },
  kindle: { label: 'Kindle', build: q => 'https://www.amazon.ca/s?k=' + q + '&i=digital-text' },
  libro:  { label: 'Libro.fm', build: q => 'https://libro.fm/search?q=' + q },
};
const GIFT_RETAILER_SETS = { print: ['indigo', 'amazon'], ebook: ['kobo', 'kindle'], audio: ['libro'] };
const GIFT_RETAILER_DEFAULTS = { print: 'indigo', ebook: 'kobo', audio: 'libro' };
function giftRetailerPrefs() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(GIFT_RETAILERS_KEY) || 'null'); } catch (e) {}
  const out = {};
  ['print', 'ebook', 'audio'].forEach(kind => {
    const want = v && typeof v === 'object' ? v[kind] : null;
    out[kind] = GIFT_RETAILER_SETS[kind].indexOf(want) !== -1 ? want : GIFT_RETAILER_DEFAULTS[kind];
  });
  return out;
}
function giftRetailerPref(kind) { return giftRetailerPrefs()[kind] || GIFT_RETAILER_DEFAULTS[kind]; }
function giftSetRetailerPref(kind, id) {
  if (GIFT_RETAILER_SETS[kind].indexOf(id) === -1) return;
  const prefs = giftRetailerPrefs();
  prefs[kind] = id;
  try { localStorage.setItem(GIFT_RETAILERS_KEY, JSON.stringify(prefs)); } catch (e) {}
  try { if (typeof userStatePush === 'function') userStatePush(); } catch (e) {}
}
/* The search query: the ISBN-13 when the record has one, else
 * "Title FirstAuthor" (the retailer's own search does the rest). */
function giftSearchQuery(book) {
  const d = (book && book.data && typeof book.data === 'object') ? book.data : (book || {});
  const isbn = giftIsbn13((d.isbn != null && d.isbn !== '') ? d.isbn : (book && book.isbn));
  if (isbn) return isbn;
  const title = String(d.title || (book && book.title) || '').trim();
  const a = d.authors != null ? d.authors : (book && book.authors);
  let first = '';
  if (Array.isArray(a)) first = a[0] || '';
  else if (typeof a === 'string') first = a;
  return (title + ' ' + String(first).trim()).trim();
}
function giftRetailerLink(book, kind, retailerId) {
  const r = GIFT_RETAILERS[retailerId] || GIFT_RETAILERS[GIFT_RETAILER_DEFAULTS[kind]];
  return r.build(encodeURIComponent(giftSearchQuery(book)));
}

/* ---------- the claim display cache ----------
 * Claims carry keys, not titles; the list views resolve names
 * from what THIS device saw at claim time (title + recipient),
 * degrading to the key label when the cache has nothing. */
function giftClaimsLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(GIFT_CLAIMS_LOCAL_KEY) || 'null');
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (e) { return {}; }
}
function giftCacheClaim(key, info) {
  if (!key) return;
  const all = giftClaimsLocal();
  all[key] = info;
  try { localStorage.setItem(GIFT_CLAIMS_LOCAL_KEY, JSON.stringify(all)); } catch (e) {}
}
function giftClaimTitle(key) {
  const info = giftClaimsLocal()[key];
  return (info && info.title) || giftKeyLabel(key);
}
function giftClaimRecipientName(key) {
  const info = giftClaimsLocal()[key];
  return (info && info.recipientName) || '';
}

/* ---------- copy (clipboard, with the legacy fallback) ---------- */
async function giftCopyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast('Copied');
      return;
    }
    throw new Error('no clipboard');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied');
    } catch (e2) { toast('Couldn’t copy — long-press to copy it manually'); }
  }
}

/* ---------- the sheets (covenOpenSheet: swipe-to-dismiss is
 * inherited, js/195) ---------- */

/* The retailer block shared by both sheets: a switcher (the
 * per-format remembered choice) and the one prominent buy button.
 * Switching remembers the choice and re-points the button. */
function giftRetailerBlockHTML(book, kind) {
  const set = GIFT_RETAILER_SETS[kind];
  const chosen = giftRetailerPref(kind);
  let html = '<div class="field"><label>Buy this book</label>';
  if (set.length > 1) {
    html += '<div class="seg" id="gift-retailers">' + set.map(id =>
      '<button data-gr="' + id + '"' + (id === chosen ? ' class="active"' : '') +
      ' aria-pressed="' + (id === chosen ? 'true' : 'false') + '">' +
      GIFT_RETAILERS[id].label + '</button>').join('') + '</div>';
  }
  html += '<a class="btn block" id="gift-buy" target="_blank" rel="noopener" href="' +
    esc(giftRetailerLink(book, kind, chosen)) + '">Buy on ' + esc(GIFT_RETAILERS[chosen].label) + '</a>' +
    '<p class="note" style="margin:6px 0 0">The retailer handles the sale, payment and delivery — Cozy Libram just points you at the right book.</p></div>';
  return html;
}
function giftWireRetailerBlock(sheet, book, kind) {
  const buy = sheet.querySelector('#gift-buy');
  sheet.querySelectorAll('#gift-retailers button').forEach(b => b.addEventListener('click', () => {
    giftSetRetailerPref(kind, b.dataset.gr);
    sheet.querySelectorAll('#gift-retailers button').forEach(x => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false'); // v590: keep state programmatic
    });
    if (buy) {
      buy.href = giftRetailerLink(book, kind, b.dataset.gr);
      buy.textContent = 'Buy on ' + GIFT_RETAILERS[b.dataset.gr].label;
    }
  }));
}

/* Revealed delivery details: one row per field the claim's format
 * kind scopes in, each with its own copy button; print adds the
 * full address block copy. Values ride in a closure, never in the
 * DOM's data attributes. */
function giftDetailsHTML(d) {
  if (!d || !d.kind) {
    return '<p class="note" style="margin:0 0 4px">' + esc(GIFT_NO_DETAILS_LINE) + '</p>';
  }
  const fields = [];
  if (d.kind === 'print') {
    [['Name', d.name], ['Street', d.street], ['City', d.city], ['Province or state', d.region],
     ['Postal code', d.postal], ['Country', d.country], ['Phone', d.phone]
    ].forEach(([label, v]) => { if (v) fields.push([label, String(v)]); });
  } else if (d.email) {
    fields.push(['Gift email', String(d.email)]);
  }
  if (!fields.length) {
    return '<p class="note" style="margin:0 0 4px">' + esc(GIFT_NO_DETAILS_LINE) + '</p>';
  }
  let html = '<div class="field"><label>Delivery details</label>' +
    fields.map(([label, v], i) =>
      '<div class="circle-row"><div class="circle-meta"><b>' + esc(v) + '</b>' +
      '<span class="note">' + esc(label) + '</span></div>' +
      '<div class="circle-actions"><button class="btn ghost sm" data-gift-copy="' + i + '">Copy</button></div></div>'
    ).join('');
  if (d.kind === 'print') {
    html += '<div class="modal-actions"><button class="btn ghost" data-gift-copy="all">Copy address</button></div>';
  }
  return html + '</div>';
}
function giftWireDetails(sheet, d) {
  if (!d || !d.kind) return;
  const vals = {};
  if (d.kind === 'print') {
    let i = 0;
    [['name', d.name], ['street', d.street], ['city', d.city], ['region', d.region],
     ['postal', d.postal], ['country', d.country], ['phone', d.phone]
    ].forEach(([k, v]) => { if (v) vals[i++] = String(v); });
    // The full block in the spec's shape, so the pasted address
    // reads exactly like a checkout form expects.
    vals.all = [d.name, d.street,
      [d.city, d.region].filter(Boolean).join(', ') + (d.postal ? ' ' + d.postal : ''),
      d.country].filter(Boolean).join('\n');
  } else if (d.email) {
    vals[0] = String(d.email);
  }
  sheet.querySelectorAll('[data-gift-copy]').forEach(b => b.addEventListener('click', () => {
    const v = vals[b.getAttribute('data-gift-copy')];
    if (v) giftCopyText(v);
  }));
}

/* The "Send this gift" sheet (after a successful claim): asks the
 * reveal RPC for the delivery details — the answer is either the
 * field-scoped details or the one generic line — and always shows
 * the retailer block + the claim's state line. */
async function openGiftSendSheet(cfg, opener) {
  const body =
    '<p class="note" style="margin-top:0">For <b>' + esc(cfg.recipientName || 'your friend') + '</b> — ' +
    esc(cfg.title || giftKeyLabel(cfg.key)) + '</p>' +
    '<div id="gift-details"><p class="note" style="margin:0">Getting delivery details…</p></div>' +
    giftRetailerBlockHTML(cfg.book, cfg.kind) +
    '<p class="note" style="margin:0">Claimed · expires ' + esc(fmtDate(cfg.expiresAt)) + '</p>';
  const ref = covenOpenSheet('Send this gift', body, opener || null);
  giftWireRetailerBlock(ref.sheet, cfg.book, cfg.kind);
  const d = await giftRpc('gift_address_reveal', { p_owner: cfg.recipientId, p_claim: cfg.claimId });
  const slot = ref.sheet.querySelector('#gift-details');
  if (!slot || !document.body.contains(slot)) return;
  slot.innerHTML = giftDetailsHTML(d);
  giftWireDetails(ref.sheet, d);
}

/* The minimal sheet for your OWN books (own wishlist, modal trophy
 * want): the retailer block only — no claim, no address, nothing
 * to coordinate with. */
function openGiftBuySheet(book, kind, opener) {
  const body =
    '<p class="note" style="margin-top:0">' + esc(book.title || 'This book') + '</p>' +
    giftRetailerBlockHTML(book, kind);
  const ref = covenOpenSheet('Buy this book', body, opener || null);
  giftWireRetailerBlock(ref.sheet, book, kind);
}

/* ---------- Friend's Wishlist shelf: Gift / Claimed ----------
 * Slots are rendered by js/195 (data-gift-slot per giftable card);
 * this fills them — and only once the server says this pair may
 * gift at all (gift_can_gift) and which books are claimed
 * (gift_claim_states_for). Any other world leaves the slots empty
 * and the shelf exactly as it always rendered. */
async function fillGiftShelfActions() {
  const slots = Array.from(document.querySelectorAll('[data-gift-slot]'));
  if (!slots.length || typeof circFriend === 'undefined' || !circFriend) return;
  const fid = circFriend.id;
  const stillHere = () => typeof circFriend !== 'undefined' && circFriend && circFriend.id === fid &&
    document.body.contains(slots[0]);
  if (!(await giftSupported())) return;
  const can = await giftRpc('gift_can_gift', { p_recipient: fid });
  if (can !== true || !stillHere()) return;
  const states = await giftRpc('gift_claim_states_for', { p_recipient: fid });
  if (!stillHere()) return;
  const claimed = {};
  (states || []).forEach(s => { if (s && s.book_key) claimed[s.book_key] = true; });
  slots.forEach(slot => {
    if (!document.body.contains(slot)) return;
    const b = (typeof circBookMap !== 'undefined' && circBookMap) ? circBookMap[slot.getAttribute('data-gift-slot')] : null;
    if (!b) return;
    const key = giftBookKey(b);
    if (!key) return;
    if (claimed[key]) {
      slot.innerHTML = '<button class="btn ghost sm" disabled>Claimed</button>';
    } else {
      slot.innerHTML = '<button class="btn ghost sm" data-gift-claim="' + esc(b.id) + '">Gift</button>';
      const btn = slot.querySelector('[data-gift-claim]');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        giftClaimTap(fid, b, key, btn);
      });
    }
  });
}
async function giftClaimTap(fid, book, key, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const res = await giftRpc('gift_claim', { p_recipient: fid, p_book_key: key });
  if (!res || res.ok !== true) {
    // Locked, capped, or the grant moved since the shelf rendered:
    // re-ask the server what the states are and repaint the actions —
    // no sheet, no error text (the refusal shapes are identical).
    fillGiftShelfActions();
    return;
  }
  giftCacheClaim(key, {
    title: book.title || '',
    recipientId: fid,
    recipientName: (typeof circFriend !== 'undefined' && circFriend) ? circFriend.name : '',
    formatKind: res.format_kind || '',
  });
  openGiftSendSheet({
    recipientId: fid,
    recipientName: (typeof circFriend !== 'undefined' && circFriend) ? circFriend.name : '',
    claimId: res.claim_id,
    expiresAt: res.expires_at,
    book: book,
    kind: res.format_kind || giftFormatKind(book.wantFormat || book.format),
    key: key,
    title: book.title || '',
  }, btn);
}

/* ---------- your own shelves: the Buy action ---------- */

/* js/190 slots (data-gift-buy-slot="<book id>") on the Wishlist
 * shelf — wishlist books and trophy wants alike. */
async function fillOwnGiftBuys() {
  const slots = Array.from(document.querySelectorAll('[data-gift-buy-slot]'));
  if (!slots.length) return;
  if (!(await giftSupported())) return;
  const lib = (typeof library !== 'undefined' && Array.isArray(library)) ? library : [];
  slots.forEach(slot => {
    const b = lib.find(x => x && x.id === slot.getAttribute('data-gift-buy-slot'));
    if (!b) return;
    const kind = (typeof isTrophyWant === 'function' && isTrophyWant(b))
      ? giftFormatKind(b.wantFormat) : giftFormatKind(b.format);
    slot.innerHTML = '<button class="btn ghost sm" data-gift-buy="' + esc(b.id) + '">Buy</button>';
    slot.querySelector('[data-gift-buy]').addEventListener('click', (e) => {
      e.stopPropagation();
      openGiftBuySheet(b, kind, e.currentTarget);
    });
  });
}

/* js/150 slot: the Buy button under a trophy want in your own book
 * modal. The kind follows the WANTED format. */
async function giftModalBuySlot(slot, book) {
  if (!slot || !book) return;
  if (!(await giftSupported())) return;
  if (!document.body.contains(slot)) return;
  slot.innerHTML = '<button class="btn ghost sm" id="f-giftbuy-btn">Buy the ' +
    esc((typeof FORMAT_META !== 'undefined' && FORMAT_META[book.wantFormat])
      ? FORMAT_META[book.wantFormat].label : 'other format') + ' edition</button>';
  slot.querySelector('#f-giftbuy-btn').addEventListener('click', (e) => {
    openGiftBuySheet(book, giftFormatKind(book.wantFormat), e.currentTarget);
  });
}

/* ---------- "Gifts you're giving" (off the Circle) ---------- */

async function fillGiftGivingEntry(slot) {
  if (!slot || typeof cloudUser === 'undefined' || !cloudUser) return;
  if (!(await giftSupported())) return;
  if (!document.body.contains(slot)) return;
  slot.innerHTML = '<div style="margin:14px 0 4px"><button class="btn ghost block" id="gift-giving-open">' +
    icon('gift') + ' Gifts you’re giving</button></div>';
  slot.querySelector('#gift-giving-open').addEventListener('click', (e) => openGiftGivingSheet(e.currentTarget));
}
async function openGiftGivingSheet(opener) {
  const rows = await giftRpc('gift_claims_mine');
  const visible = (rows || []).filter(r => r && (r.state === 'active' || r.state === 'purchased'));
  let body;
  if (!visible.length) {
    body = '<p class="note" style="margin:0">Nothing here yet. When you tap Gift on a friend’s wishlist book, the claim waits here until you buy it or let it go.</p>';
  } else {
    body = '<div class="circle-list">' + visible.map(r => {
      const name = giftClaimRecipientName(r.book_key);
      const meta = (name ? 'For ' + esc(name) + ' · ' : '') +
        (r.state === 'purchased' ? 'Purchased' : 'Expires ' + esc(fmtDate(r.expires_at)));
      const actions = r.state === 'purchased'
        ? '<span class="note">Purchased</span>'
        : '<button class="btn ghost sm" data-gift-purchased="' + esc(r.claim_id) + '">Mark purchased</button>' +
          '<button class="btn ghost sm" data-gift-release="' + esc(r.claim_id) + '">Release claim</button>';
      return '<div class="circle-row"><div class="circle-meta"><b>' + esc(giftClaimTitle(r.book_key)) + '</b>' +
        '<span class="note">' + meta + '</span></div>' +
        '<div class="circle-actions">' + actions + '</div></div>';
    }).join('') + '</div>' +
    '<p class="note" style="margin:8px 0 0">Claims free the book for other friends the moment they’re released, purchased, or expire (45 days) — and if your friend gets the book themselves first, the claim quietly lets go.</p>';
  }
  const ref = covenOpenSheet('Gifts you’re giving', body, opener || null);
  ref.sheet.querySelectorAll('[data-gift-purchased]').forEach(b => b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    const r = await giftRpc('gift_mark_purchased', { p_claim: b.getAttribute('data-gift-purchased') });
    if (r && r.ok === true) { toast('Marked as purchased'); openGiftGivingSheet(opener); }
    else { b.disabled = false; toast('Couldn’t update that claim'); }
  }));
  ref.sheet.querySelectorAll('[data-gift-release]').forEach(b => b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true;
    const r = await giftRpc('gift_release', { p_claim: b.getAttribute('data-gift-release') });
    if (r && r.ok === true) { toast('Claim released'); openGiftGivingSheet(opener); }
    else { b.disabled = false; toast('Couldn’t release that claim'); }
  }));
}

/* ---------- The gift cluster (hybrid placement): giftClusterHTML
 * mounts the See-claims seg + the slot fillGiftSettings fills with
 * the sharing toggle, the per-friend grants, the recipient claims,
 * and the address access log — on the Profile view, under the
 * identity form (v590 had it in Settings → Account; the hybrid moved
 * the mount, nothing else); the same cluster follows the Circle &
 * privacy panel in the Hearth sheet. fillGiftAddress mounts the
 * gift address editor in the account form's slot (js/105). ---------- */

/* The teen storage ban (spec §7/A9): the address form is never
 * offered to a teen-band account. The band is device state —
 * privacyState() (js/230) reads the same localStorage key. */
function giftTeenBand() {
  try {
    if (typeof privacyState === 'function') return privacyState().band === 'teen';
    const s = JSON.parse(localStorage.getItem('cozylibram.privacy.v1') || 'null');
    return !!(s && s.band === 'teen');
  } catch (e) { return false; }
}
function giftSegHTML(id, on) {
  // v590: the privacy panel's shared builder (js/195) — same markup,
  // same aria-pressed contract, one source.
  if (typeof circleSegHTML === 'function') return circleSegHTML(id, on);
  return '<div class="seg" id="' + id + '">' +
    '<button data-v="1"' + (on ? ' class="active"' : '') + ' aria-pressed="' + (on ? 'true' : 'false') + '">On</button>' +
    '<button data-v="0"' + (!on ? ' class="active"' : '') + ' aria-pressed="' + (!on ? 'true' : 'false') + '">Off</button></div>';
}

/* The gift cluster's shell — the recipient claim-visibility opt-in
 * plus the slot fillGiftSettings fills (sharing toggle, per-friend
 * grants, claims list, address-views log). One builder for both
 * doors: the Profile view renders it under the identity form, the
 * Hearth privacy sheet appends it after the Circle & privacy panel.
 * The SEE CLAIMS helper below is the single source for
 * the setting's explanation — it states the shipped mechanics (the
 * claims list shows book + claimer + state, per the gift RPCs); the
 * older Hearth copy describing a "marker on your copy" was wrong and
 * is retired with the fork. The wrapper starts hidden and is only
 * revealed once giftSupported() confirms the server supports gifts
 * (fail closed: pre-migration it never appears anywhere). */
function giftClusterHTML(p, giftClaimsOn) {
  return '<div id="' + p + '-giftwrap" hidden>' +
    '<div class="field"><label>See claims on my wishlist</label>' + giftSegHTML(p + '-giftclaims', giftClaimsOn === true) +
    '<p class="note">When on, you can see which of your wishlist books friends have claimed — and who claimed them — right here. Off (the default) keeps gifts a complete surprise: you see nothing about claims, anywhere.</p></div>' +
    '<div id="' + p + '-gift-slot"></div></div>';
}
function giftWireSeg(root, id, initial, onChange) {
  let val = !!initial;
  root.querySelectorAll('#' + id + ' button').forEach(b => b.addEventListener('click', async () => {
    const v = b.dataset.v === '1';
    if (val === v) return;
    const prev = val;
    val = v;
    const okSave = await onChange(v);
    if (okSave === false) { val = prev; return; }
    root.querySelectorAll('#' + id + ' button').forEach(x => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false'); // v590: keep state programmatic
    });
  }));
}

async function fillGiftSettings(slot) {
  if (!slot || typeof cloudUser === 'undefined' || !cloudUser) return;
  if (!(await giftSupported())) return;
  if (!document.body.contains(slot)) return;
  const sb = await cloudClient().catch(() => null);
  if (!sb) return;
  const me = cloudUser.id;

  /* --- per-friend gifting grants --- */
  let friends = [];
  try { friends = (await circleLists()).friends || []; } catch (e) { friends = []; }
  let grantSet = {};
  try {
    const g = await sb.from('gift_grants').select('friend_id').eq('recipient_id', me);
    if (g.error) { if (giftLatchIfMissing(g.error)) return; giftLog('grants read failed:', g.error.message || g.error); }
    else (g.data || []).forEach(r => { grantSet[r.friend_id] = true; });
  } catch (e) { giftLog('grants read threw', e); }

  /* --- the recipient-side claims (behind its toggle) --- */
  let recipClaims = [];
  let claimsOn = false;
  try {
    const priv = await circlePrivacy();
    claimsOn = priv.giftClaims === true;
  } catch (e) { /* toggle state unknown: the claims list just stays off */ }
  if (claimsOn) recipClaims = (await giftRpc('gift_claims_for_recipient')) || [];
  if (!document.body.contains(slot)) return;

  const friendName = {};
  friends.forEach(f => { friendName[f.id] = f.name; });
  const firstName = f => (f.profile && f.profile.first_name) || f.name || 'A friend';

  let html = '';
  /* grants */
  html += '<div class="field"><label>Gifting</label>' +
    '<p class="note" style="margin:0 0 6px">Only friends you switch on here can gift you books from your wishlist — everyone else sees it exactly as before, with no trace of gifting.</p>';
  if (!friends.length) {
    html += '<p class="note">No friends yet — grants are per friend, so there’s nobody to switch on.</p>';
  } else {
    html += friends.map(f =>
      '<div class="field"><label>Allow ' + esc(firstName(f)) + ' to gift me</label>' +
      giftSegHTML('gift-grant-' + f.id, !!grantSet[f.id]) + '</div>'
    ).join('');
  }
  html += '</div>';

  /* recipient claims (rendered only while the opt-in is on) */
  if (claimsOn) {
    html += '<div class="field"><label>Claims on your wishlist</label>';
    if (!recipClaims.length) {
      html += '<p class="note">No claims right now.</p>';
    } else {
      html += '<div class="circle-list">' + recipClaims.map(r =>
        '<div class="circle-row"><div class="circle-meta"><b>' + esc(giftKeyLabel(r.book_key)) + '</b>' +
        '<span class="note">Claimed by ' + esc(friendName[r.claimer_id] || 'A friend') + '</span></div></div>'
      ).join('') + '</div>';
    }
    html += '</div>';
  }

  /* access log — pull-only disclosure. v590: the timing explanation
   * (fact tier at 72h; claimer + book at resolution or 14 days) is
   * stated at the row itself — it used to exist only inside the
   * log's empty state, where nobody with views ever saw it. */
  html += '<div class="field"><label>Gift address views</label>' +
    '<p class="note" style="margin:0 0 6px">When a friend views your address to send a gift, it’s logged here. Views appear 72 hours after they happen; who viewed, and which book, appears once the gift is settled or 14 days pass.</p>' +
    '<button class="btn ghost sm" id="gift-log-open">Show views</button>' +
    '<div id="gift-log-list"></div></div>';

  slot.innerHTML = html;

  /* grants wiring */
  friends.forEach(f => {
    giftWireSeg(slot, 'gift-grant-' + f.id, !!grantSet[f.id], async (v) => {
      try {
        const r = v
          ? await sb.from('gift_grants').insert({ recipient_id: me, friend_id: f.id })
          : await sb.from('gift_grants').delete().eq('recipient_id', me).eq('friend_id', f.id);
        if (r.error) {
          if (giftLatchIfMissing(r.error)) { slot.innerHTML = ''; return false; }
          throw r.error;
        }
        toast(v ? firstName(f) + ' can gift you now' : firstName(f) + ' can no longer gift you');
        return true;
      } catch (e) {
        toast('Couldn’t save: ' + ((e && e.message) || e));
        return false;
      }
    });
  });

  /* access log wiring: fetch on open, then just expand/collapse */
  const logBtn = slot.querySelector('#gift-log-open');
  const logList = slot.querySelector('#gift-log-list');
  if (logBtn && logList) logBtn.addEventListener('click', async () => {
    if (logList.dataset.loaded) {
      const open = logList.style.display !== 'none';
      logList.style.display = open ? 'none' : '';
      logBtn.textContent = open ? 'Show views' : 'Hide views';
      return;
    }
    logBtn.disabled = true;
    const rows = await giftRpc('gift_address_log_mine');
    logBtn.disabled = false;
    if (!document.body.contains(logList)) return;
    logList.dataset.loaded = '1';
    logBtn.textContent = 'Hide views';
    if (!rows || !rows.length) {
      logList.innerHTML = '<p class="note" style="margin:6px 0 0">No views to show. Views appear here 72 hours after they happen; who viewed, and which book, appears once the gift is settled or 14 days pass.</p>';
      return;
    }
    logList.innerHTML = '<div class="circle-list" style="margin-top:8px">' + rows.map(r => {
      // Fact tier (viewer not yet resolvable): date + the generic
      // line. Detail tier: name — book — date.
      const line = r.viewer_id
        ? esc(friendName[r.viewer_id] || 'A friend') + ' — ' + esc(giftKeyLabel(r.book_key)) + ' — ' + esc(fmtDate(r.revealed_at))
        : esc(fmtDate(r.revealed_at)) + ' — a friend viewed your gift address';
      return '<div class="circle-row"><div class="circle-meta"><span>' + line + '</span></div></div>';
    }).join('') + '</div>';
  });
}

/* ---------- Profile surface: the gift address editor ----------
 * The address editor lives with the rest of the user's own details
 * (Profile, js/105 mounts the slot). Same fields, same RPCs, same
 * fail-closed behaviour as when it sat in Circle & privacy; the
 * access log did NOT move (it stays in fillGiftSettings above).
 * The country is a select keyed to js/244's vendored list; the
 * stored value is the country NAME (e.g. "Canada") — the same
 * human-readable shape the column has always held, and what the
 * reveal shows a gift buyer. Postal validation (js/244) runs
 * on-device before save: malformed blocks, doubtful warns with an
 * explicit Save anyway, and only the normalized postal value rides
 * the payload — the verdict itself is never stored or sent. */
async function fillGiftAddress(slot) {
  if (!slot || typeof cloudUser === 'undefined' || !cloudUser) return;
  if (giftTeenBand()) return; // the form is never offered to teen-band accounts
  if (!(await giftSupported())) return;
  if (!document.body.contains(slot)) return;
  const mine = await giftRpc('gift_address_mine');
  if (!document.body.contains(slot)) return;
  const a = (mine && mine.exists) ? mine : {};
  const val = k => esc(a[k] == null ? '' : String(a[k]));

  /* Resolve the stored country (free text historically: "Canada",
   * "CA", …) to a list entry. An unmatched legacy value keeps its
   * own option so the saved data is never silently rewritten, and
   * validates as unknown-country (no checks) until re-picked. */
  const storedCountry = a.country == null ? '' : String(a.country);
  const storedCode = (typeof giftCountryCodeFor === 'function') ? giftCountryCodeFor(storedCountry) : '';
  let options = '';
  if (storedCountry && !storedCode) {
    options += '<option value="' + esc(storedCountry) + '" data-code="" selected>' + esc(storedCountry) + '</option>';
  }
  options += GIFT_COUNTRIES.map(c =>
    '<option value="' + esc(c[1]) + '" data-code="' + c[0] + '"' +
    (c[0] === storedCode || (!storedCountry && c[0] === 'CA') ? ' selected' : '') + '>' + esc(c[1]) + '</option>'
  ).join('');

  slot.innerHTML =
    '<div class="field"><label>Gift address</label>' +
    '<p class="note" style="margin:0 0 8px">Your delivery details for gifts. They’re stored encrypted, and a friend sees them only while they hold a claim on one of your wishlist books and you’ve switched sharing on.</p>' +
    '<div class="field"><label for="gift-addr-name">Name</label>' +
    '<input id="gift-addr-name" class="text-input" autocomplete="name" value="' + val('name') + '"></div>' +
    '<div class="field"><label for="gift-addr-street">Street</label>' +
    '<input id="gift-addr-street" class="text-input" autocomplete="street-address" value="' + val('street') + '"></div>' +
    '<div class="field"><label for="gift-addr-city">City</label>' +
    '<input id="gift-addr-city" class="text-input" autocomplete="address-level2" value="' + val('city') + '"></div>' +
    '<div class="field"><label for="gift-addr-region">Province or state</label>' +
    '<input id="gift-addr-region" class="text-input" autocomplete="address-level1" value="' + val('region') + '"></div>' +
    '<div class="field"><label for="gift-addr-postal">Postal code</label>' +
    '<input id="gift-addr-postal" class="text-input" autocomplete="postal-code" value="' + val('postal') + '"></div>' +
    '<div class="field"><label for="gift-addr-country">Country</label>' +
    '<select id="gift-addr-country" class="text-input" autocomplete="country-name">' + options + '</select></div>' +
    '<div class="field"><label for="gift-addr-phone">Phone (optional)</label>' +
    '<input id="gift-addr-phone" class="text-input" autocomplete="tel" value="' + val('phone') + '"></div>' +
    '<div class="field"><label for="gift-addr-email">Gift email</label>' +
    '<input id="gift-addr-email" class="text-input" autocomplete="email" placeholder="For ebook &amp; audio gifts" value="' + val('email') + '"></div>' +
    '<p class="note" id="gift-addr-msg" role="alert" hidden></p>' +
    '<div class="modal-actions"><button class="btn" id="gift-addr-save">Save address</button>' +
    '<button class="btn ghost" id="gift-addr-save-anyway" hidden>Save anyway</button>' +
    ((mine && mine.exists) ? '<button class="btn ghost" id="gift-addr-delete">Delete address</button>' : '') +
    '</div></div>' +
    '<div class="field"><label>Share my gift address with claimers</label>' +
    giftSegHTML('gift-sharing', !!(mine && mine.sharing_enabled)) +
    '<p class="note">Friends who claim one of your wishlist books can see this address to ship it to you.</p></div>';

  const field = id => { const el = slot.querySelector('#' + id); return el ? el.value.trim() : ''; };
  const countryEl = slot.querySelector('#gift-addr-country');
  const msgEl = slot.querySelector('#gift-addr-msg');
  const saveBtn = slot.querySelector('#gift-addr-save');
  const anywayBtn = slot.querySelector('#gift-addr-save-anyway');

  /* Any edit after a warning retires the warning: "Save anyway"
   * only ever applies to the exact values that were warned about. */
  const resetVerdict = () => {
    if (msgEl) { msgEl.hidden = true; msgEl.textContent = ''; }
    if (anywayBtn) anywayBtn.hidden = true;
  };
  slot.querySelectorAll('#gift-addr-region, #gift-addr-postal').forEach(el =>
    el.addEventListener('input', resetVerdict));
  if (countryEl) countryEl.addEventListener('change', resetVerdict);

  async function doSave() {
    const opt = countryEl && countryEl.selectedOptions ? countryEl.selectedOptions[0] : null;
    const code = opt ? (opt.getAttribute('data-code') || '') : '';
    const check = (typeof giftPostalCheck === 'function')
      ? giftPostalCheck(code, field('gift-addr-postal'), field('gift-addr-region'))
      : { status: 'skip', normalized: field('gift-addr-postal'), message: '' };
    if (check.status === 'block') {
      if (msgEl) { msgEl.textContent = check.message; msgEl.hidden = false; }
      if (anywayBtn) anywayBtn.hidden = true;
      return;
    }
    if (check.status === 'warn' && !doSave.force) {
      // v590: the pair must explain itself — what Save anyway bypasses
      // (this one warning, nothing else) was previously nowhere stated.
      if (msgEl) { msgEl.textContent = check.message + ' Save anyway keeps the values exactly as typed — it bypasses this check only, and the address is still saved encrypted the same way.'; msgEl.hidden = false; }
      if (anywayBtn) anywayBtn.hidden = false;
      return;
    }
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    if (anywayBtn) anywayBtn.disabled = true;
    const r = await giftRpc('gift_address_upsert', {
      p_name: field('gift-addr-name'), p_street: field('gift-addr-street'),
      p_city: field('gift-addr-city'), p_region: field('gift-addr-region'),
      p_postal: check.normalized, p_country: field('gift-addr-country'),
      p_phone: field('gift-addr-phone'), p_email: field('gift-addr-email'),
    });
    if (r && r.ok === true) { toast('Gift address saved'); fillGiftAddress(slot); }
    else {
      saveBtn.disabled = false;
      if (anywayBtn) anywayBtn.disabled = false;
      toast('Couldn’t save your gift address');
    }
  }
  if (saveBtn) saveBtn.addEventListener('click', () => { doSave.force = false; doSave(); });
  if (anywayBtn) anywayBtn.addEventListener('click', () => { doSave.force = true; doSave(); });

  const delBtn = slot.querySelector('#gift-addr-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (delBtn.disabled) return;
    delBtn.disabled = true;
    const r = await giftRpc('gift_address_delete');
    if (r && r.ok === true) { toast('Gift address deleted'); fillGiftAddress(slot); }
    else { delBtn.disabled = false; toast('Couldn’t delete your gift address'); }
  });
  giftWireSeg(slot, 'gift-sharing', !!(mine && mine.sharing_enabled), async (v) => {
    const r = await giftRpc('gift_address_set_sharing', { p_on: v });
    if (r && r.ok === true) {
      toast(v ? 'Your gift address can be shared with claimers' : 'Your gift address is no longer shared');
      return true;
    }
    toast('Couldn’t save that setting');
    return false;
  });
}
