// "Gift a Book" v1 (spec: docs/gift-purchase-spec.md).
//
// Two layers, after the marginalia suite's shape:
//   1. SQL shape pins over the migration AND schema.sql: tables,
//      policies, the definer-RPC predicate composition — including the
//      reveal RPC's predicate ORDER (grant → link → block → toggle →
//      live claim → budgets → claim age), the caps (2/recipient,
//      10 global), the budgets (3/claim, 10/pair/30d), the 24h
//      first-pair claim age, the log tiers (72h / resolution-or-14d),
//      the pinned friends payload (book_key + state only), and the
//      pgsodium wiring (vault-held key id, AEAD-IETF, nonce-packed,
//      owner-bound additional data).
//   2. A stub harness emulating the RPC semantics over an in-memory
//      world with a controllable clock, running the spec §10 matrices:
//      grant matrix + mid-claim revocation, the one-claim lock, claimer
//      caps, serve-time composition (link loss, block, self-acquire,
//      wishlist hide, expiry), pair budgets + claim-cycling, the
//      first-pair claim-age rule, field scoping, the two-tier log, the
//      recipient visibility setting, and the minors matrix. Every
//      refusal shape is asserted IDENTICAL across causes.
//
// The stub is a semantics model of the migration, not a copy of it; the
// coordinator's post-apply spot-check exercises the real RPCs.
'use strict';
const fs = require('fs');
const path = require('path');
const APP_DIR = process.env.BOOKTOK_DIR || path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok -', label); } else { fail++; console.log('  NOT OK -', label); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86400000, HOUR = 3600000;

/* ================= SQL shape: the real enforcement ================= */
const mig = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v582_gift_a_book.sql'), 'utf8');
const schema = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
const fnBody = (sql, name) => (sql.split('function public.' + name + '(')[1] || '').split('$$;')[0];

for (const [label, sql] of [['migration', mig], ['schema.sql', schema]]) {
  ok(label + ': pgsodium extension + vault-held key, AEAD-IETF, nonce-packed, owner-bound',
    /create extension if not exists pgsodium/.test(sql) &&
    /create_key\(name := 'gift-address-v1'\)/.test(sql) &&
    /crypto_aead_ietf_encrypt/.test(sql) && /crypto_aead_ietf_decrypt/.test(sql) &&
    /gen_random_bytes\(24\)/.test(sql) &&
    /substring\(p_packed from 25\)/.test(sql) && /substring\(p_packed from 1 for 24\)/.test(sql) &&
    /p_owner::text \|\| ':gift-address-v1'/.test(sql));
  ok(label + ': gift_grants recipient-managed, absence is OFF',
    /create table if not exists public\.gift_grants/.test(sql) &&
    /create policy "recipient manages own gift grants" on public\.gift_grants/.test(sql) &&
    /recipient_id = auth\.uid\(\)/.test(sql) &&
    /grant select, insert, delete on public\.gift_grants to authenticated/.test(sql));
  ok(label + ': gift_addresses owner-only SELECT; no client write policy on the vault',
    /create table if not exists public\.gift_addresses/.test(sql) &&
    /create policy "owner reads own gift address row" on public\.gift_addresses/.test(sql) &&
    /owner_id = auth\.uid\(\)/.test(sql) &&
    /sharing_enabled boolean not null default false/.test(sql) &&
    !/create policy "[^"]*" on public\.gift_addresses[^;]*for (insert|update|delete)/.test(sql));
  ok(label + ': gift_claims zero-policy (admin SELECT only), stored states only',
    /create table if not exists public\.gift_claims/.test(sql) &&
    /create policy "admins read gift claims" on public\.gift_claims/.test(sql) &&
    /using \(is_admin\(\)\)/.test(fnBody(sql, 'gift_claim') === '' ? sql : sql) &&
    /state in \('active', 'purchased', 'released'\)/.test(sql) &&
    /revoke all on public\.gift_claims from anon, authenticated/.test(sql));
  ok(label + ': access log zero-policy (admin SELECT only), written by reveal only',
    /create table if not exists public\.gift_address_access_log/.test(sql) &&
    /create policy "admins read gift address access log" on public\.gift_address_access_log/.test(sql) &&
    /revoke all on public\.gift_address_access_log from anon, authenticated/.test(sql));
  ok(label + ': profiles gains gift_claims_visible default false; circle_profiles view does NOT project it',
    /add column if not exists gift_claims_visible boolean not null default false/.test(sql) &&
    !(label === 'schema.sql' &&
      /create or replace view public\.circle_profiles as[\s\S]{0,1500}gift_claims_visible/.test(sql)));

  const live = fnBody(sql, 'gift_claim_is_live');
  ok(label + ': serve-time liveness composes state + 45d + grant INSTANCE + link + block + wishlist + derivation',
    /c\.state <> 'active'/.test(live) &&
    /interval '45 days'/.test(live) &&
    /g\.created_at <= c\.created_at/.test(live) &&
    /gift_pair_linked\(c\.recipient_id, c\.claimer_id\)/.test(live) &&
    /gift_pair_blocked\(c\.recipient_id, c\.claimer_id\)/.test(live) &&
    /gift_wishlist_open\(c\.recipient_id\)/.test(live) &&
    /gift_book_format_kind\(c\.recipient_id, c\.book_key\) is null/.test(live));

  const claim = fnBody(sql, 'gift_claim');
  ok(label + ': gift_claim enforces grant/link/block/wishlist/kind + lock + caps 2 & 10, advisory locks first',
    /pg_advisory_xact_lock\(hashtextextended\('gift-claimer:'/.test(claim) &&
    /pg_advisory_xact_lock\(hashtextextended\('gift-recipient:'/.test(claim) &&
    claim.indexOf('pg_advisory_xact_lock') < claim.indexOf('gift_has_grant') &&
    />= 2 then/.test(claim) && />= 10 then/.test(claim) &&
    (claim.match(/return jsonb_build_object\('ok', false\)/g) || []).length >= 6);

  const states = fnBody(sql, 'gift_claim_states_for');
  ok(label + ': friends state RPC refuses the owner and pins payload to book_key + state',
    /p_recipient = v_uid/.test(states) &&
    /jsonb_build_object\('book_key', t\.book_key, 'state', 'claimed'\)/.test(states) &&
    !/claimer/.test(states.split('from (')[0].split('return coalesce')[1] || ''));

  const recip = fnBody(sql, 'gift_claims_for_recipient');
  ok(label + ': recipient RPC exists only behind the caller\'s own gift_claims_visible setting',
    /gift_claims_visible/.test(recip) &&
    /jsonb_build_object\(\s*'book_key', c\.book_key,\s*'claimer_id', c\.claimer_id,\s*'state', 'claimed'\)/.test(recip));

  const reveal = fnBody(sql, 'gift_address_reveal');
  const order = ['gift_has_grant(p_owner, v_uid)', 'gift_pair_linked(p_owner, v_uid)',
    'gift_pair_blocked(p_owner, v_uid)', 'a.sharing_enabled', 'gift_claim_is_live(c.id)',
    "l.claim_id = c.id", "interval '30 days'", "interval '24 hours'"];
  const idx = order.map(s => reveal.indexOf(s));
  ok(label + ': reveal predicate ORDER is grant → link → block → toggle → claim → budgets → claim age',
    idx.every(i => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]));
  ok(label + ': reveal budgets are 3 per claim and 10 per pair per rolling 30 days, counted from the log',
    />= 3 then/.test(reveal) && />= 10 then/.test(reveal) &&
    /insert into public\.gift_address_access_log/.test(reveal));
  ok(label + ': reveal field-scopes by the claim format kind (print → postal+phone, else email only)',
    /c\.format_kind = 'print'/.test(reveal) &&
    /'phone',\s*public\.gift_dec\(a\.phone_enc, p_owner\)/.test(reveal) &&
    /'email', public\.gift_dec\(a\.email_enc, p_owner\)/.test(reveal) &&
    (reveal.match(/return '\{\}'::jsonb/g) || []).length >= 7);

  const upsert = fnBody(sql, 'gift_address_upsert');
  ok(label + ': address upsert encrypts every field and refuses teen-band owners (band read from user_state)',
    /privacy_state -> 'value' ->> 'band'/.test(upsert) &&
    /= 'teen'/.test(upsert) &&
    (upsert.match(/public\.gift_enc\(/g) || []).length >= 8);

  const logMine = fnBody(sql, 'gift_address_log_mine');
  ok(label + ': owner log tiers enforced server-side (72h fact; detail at resolution or 14d)',
    /interval '72 hours'/.test(logMine) &&
    /c\.resolved_at is not null/.test(logMine) &&
    /interval '14 days'/.test(logMine));

  ok(label + ': internal helpers are revoked from every client role',
    ['gift_enc(text, uuid)', 'gift_dec(bytea, uuid)', 'gift_has_grant(uuid, uuid)',
     'gift_pair_linked(uuid, uuid)', 'gift_pair_blocked(uuid, uuid)',
     'gift_wishlist_open(uuid)', 'gift_book_format_kind(uuid, text)',
     'gift_claim_is_live(uuid)', 'gift_claim_state(uuid)'].every(sig =>
      sql.includes('revoke all on function public.' + sig.split('(')[0] + '(' + sig.split('(')[1] + ' from public, anon, authenticated')));
  ok(label + ': the thirteen RPCs are granted to authenticated only',
    ['gift_can_gift(uuid)', 'gift_claim(uuid, text)', 'gift_claim_states_for(uuid)', 'gift_claims_mine()',
     'gift_claims_for_recipient()', 'gift_mark_purchased(uuid)', 'gift_release(uuid)',
     'gift_address_upsert(text, text, text, text, text, text, text, text)',
     'gift_address_mine()', 'gift_address_set_sharing(boolean)', 'gift_address_delete()',
     'gift_address_reveal(uuid, uuid)', 'gift_address_log_mine()'].every(sig =>
      sql.includes('grant execute on function public.' + sig + ' to authenticated')));
}

/* ================= stub: RPC semantics over a fake world ================= */
let NOW = 1760000000000;
const world = () => ({
  profiles: {},   // uid -> {share:true, hidden:[], claimsVisible:false, band:null}
  links: new Set(), blocks: new Set(), grants: new Map(), // 'R>A' -> grantedAt (instance binding)
  books: {},      // uid -> [{key,status,owned,format,wantFormat}]
  claims: [], log: [], addresses: {}, seq: 0,
});
const pair = (a, b) => [a, b].sort().join('|');
const prof = (W, u) => W.profiles[u] || (W.profiles[u] = { share: true, hidden: [], claimsVisible: false, band: null });
const FMTKIND = f => f === 'ebook' ? 'ebook' : f === 'audio' ? 'audio' : 'print';
const bookKind = (W, owner, key) => {
  const rows = (W.books[owner] || []).filter(b => b.key === key);
  const derived = rows.find(b => b.status === 'tbr' && b.owned === 'tobuy');
  if (derived) return FMTKIND(derived.format || 'physical');
  const FMTS = ['hardcover', 'paperback', 'physical', 'ebook', 'audio'];
  const trophy = rows.find(b => FMTS.includes(b.format) && FMTS.includes(b.wantFormat) &&
    b.wantFormat !== b.format && !(b.status === 'tbr' && b.owned === 'tobuy'));
  return trophy ? FMTKIND(trophy.wantFormat) : null;
};
const wishlistOpen = (W, owner) => { const p = prof(W, owner); return p.share && !p.hidden.includes('wishlist') && !p.hidden.includes('tbr'); };
const grantCovers = (W, c) => { const t = W.grants.get(c.recipient + '>' + c.claimer); return t !== undefined && t <= c.createdAt; };
const isLive = (W, c) => c.state === 'active' && NOW < c.createdAt + 45 * DAY &&
  grantCovers(W, c) && W.links.has(pair(c.recipient, c.claimer)) &&
  !W.blocks.has(pair(c.recipient, c.claimer)) && wishlistOpen(W, c.recipient) &&
  bookKind(W, c.recipient, c.key) !== null;
const claimState = (W, c) => c.state !== 'active' ? c.state :
  isLive(W, c) ? 'active' : (NOW >= c.createdAt + 45 * DAY ? 'expired' : 'released');
const FAIL = { ok: false }, EMPTY = {};
function rpcClaim(W, caller, recipient, key) {
  if (!caller || recipient === caller || !key) return { ...FAIL };
  if (!W.grants.has(recipient + '>' + caller)) return { ...FAIL };
  if (!W.links.has(pair(recipient, caller))) return { ...FAIL };
  if (W.blocks.has(pair(recipient, caller))) return { ...FAIL };
  if (!wishlistOpen(W, recipient)) return { ...FAIL };
  const kind = bookKind(W, recipient, key);
  if (!kind) return { ...FAIL };
  if (W.claims.some(c => c.recipient === recipient && c.key === key && isLive(W, c))) return { ...FAIL };
  if (W.claims.filter(c => c.claimer === caller && c.recipient === recipient && isLive(W, c)).length >= 2) return { ...FAIL };
  if (W.claims.filter(c => c.claimer === caller && isLive(W, c)).length >= 10) return { ...FAIL };
  const c = { id: 'c' + (++W.seq), recipient, claimer: caller, key, kind, state: 'active', createdAt: NOW, resolvedAt: null };
  W.claims.push(c);
  return { ok: true, claim_id: c.id, format_kind: kind, expires_at: c.createdAt + 45 * DAY };
}
function rpcStates(W, caller, recipient) {
  if (!caller || recipient === caller) return [];
  if (!W.grants.has(recipient + '>' + caller)) return [];
  if (!W.links.has(pair(recipient, caller))) return [];
  if (W.blocks.has(pair(recipient, caller))) return [];
  if (!wishlistOpen(W, recipient)) return [];
  const keys = [...new Set(W.claims.filter(c => c.recipient === recipient && isLive(W, c)).map(c => c.key))].sort();
  return keys.map(k => ({ book_key: k, state: 'claimed' }));
}
const rpcMine = (W, caller) => W.claims.filter(c => c.claimer === caller)
  .map(c => ({ claim_id: c.id, recipient_id: c.recipient, book_key: c.key, format_kind: c.kind, state: claimState(W, c) }));
function rpcForRecipient(W, caller) {
  if (!prof(W, caller).claimsVisible) return [];
  return W.claims.filter(c => c.recipient === caller && isLive(W, c))
    .map(c => ({ book_key: c.key, claimer_id: c.claimer, state: 'claimed' }));
}
function rpcResolve(W, caller, id, to) {
  const c = W.claims.find(x => x.id === id);
  if (!c || c.claimer !== caller || c.state !== 'active') return { ...FAIL };
  if (to === 'purchased' && !isLive(W, c)) return { ...FAIL };
  c.state = to; c.resolvedAt = NOW; return { ok: true };
}
function rpcUpsert(W, caller, fields) {
  if (prof(W, caller).band === 'teen') return { ...FAIL };
  W.addresses[caller] = { ...(W.addresses[caller] || { sharing: false }), fields };
  return { ok: true };
}
function rpcReveal(W, caller, owner, claimId) {
  if (!caller || owner === caller) return { ...EMPTY };
  if (!W.grants.has(owner + '>' + caller)) return { ...EMPTY };
  if (!W.links.has(pair(owner, caller))) return { ...EMPTY };
  if (W.blocks.has(pair(owner, caller))) return { ...EMPTY };
  const a = W.addresses[owner];
  if (!a || !a.sharing) return { ...EMPTY };
  const c = W.claims.find(x => x.id === claimId);
  if (!c || c.claimer !== caller || c.recipient !== owner || !isLive(W, c)) return { ...EMPTY };
  if (W.log.filter(l => l.claimId === c.id).length >= 3) return { ...EMPTY };
  if (W.log.filter(l => l.viewer === caller && l.owner === owner && l.at > NOW - 30 * DAY).length >= 10) return { ...EMPTY };
  const priorResolved = W.claims.some(pc => pc.recipient === owner && pc.claimer === caller && pc.id !== c.id &&
    (pc.resolvedAt !== null || pc.createdAt + 45 * DAY <= NOW));
  if (!priorResolved && c.createdAt > NOW - 24 * HOUR) return { ...EMPTY };
  W.log.push({ viewer: caller, owner, claimId: c.id, at: NOW });
  if (c.kind === 'print') return { kind: 'print', ...a.fields.postal, phone: a.fields.phone };
  return { kind: c.kind, email: a.fields.email };
}
function rpcLogMine(W, owner) {
  return W.log.filter(l => l.owner === owner && l.at <= NOW - 72 * HOUR).map(l => {
    const c = W.claims.find(x => x.id === l.claimId);
    const detail = (c && c.resolvedAt !== null) || l.at <= NOW - 14 * DAY;
    return { revealed_at: l.at, viewer_id: detail ? l.viewer : null, book_key: detail ? c.key : null };
  });
}

/* ---- fixtures ---- */
const ADDR = { postal: { name: 'R Reader', street: '1 Main St', city: 'Moncton', region: 'NB', postal: 'E1C 1A1', country: 'CA' }, phone: '506-555-0100', email: 'gifts@example.com' };
function baseWorld() {
  const W = world();
  for (const u of ['R', 'A', 'B', 'U', 'T']) prof(W, u);
  W.links.add(pair('R', 'A')); W.links.add(pair('R', 'B')); W.links.add(pair('R', 'U')); W.links.add(pair('R', 'T'));
  W.books.R = [
    { key: 'k-print', status: 'tbr', owned: 'tobuy', format: 'paperback', wantFormat: '' },
    { key: 'k-ebook', status: 'tbr', owned: 'tobuy', format: 'ebook', wantFormat: '' },
    { key: 'k-trophy', status: 'read', owned: 'owned', format: 'ebook', wantFormat: 'hardcover' },
    { key: 'k-owned', status: 'read', owned: 'owned', format: 'paperback', wantFormat: '' },
  ];
  W.addresses.R = { sharing: true, fields: ADDR };
  return W;
}
const claimOk = (W, who, key) => rpcClaim(W, who, 'R', key);

/* ---- grant matrix ---- */
{
  const W = baseWorld();
  const noGrant = rpcClaim(W, 'A', 'R', 'k-print');
  ok('grant matrix: no grant ⇒ claim refused, states empty, shelf indistinguishable', eq(noGrant, FAIL) && eq(rpcStates(W, 'A', 'R'), []));
  W.grants.set('R>A', NOW);
  const granted = claimOk(W, 'A', 'k-print');
  ok('grant matrix: grant in force ⇒ claim succeeds with server-derived format kind', granted.ok === true && granted.format_kind === 'print');
  const st = rpcStates(W, 'B', 'R');
  ok('grant matrix: an ungranted friend still sees nothing while a claim is live', eq(st, []) );
  W.grants.set('R>B', NOW);
  const stB = rpcStates(W, 'B', 'R');
  ok('friends payload is exactly {book_key, state} — no claimer, no timestamps, no counts',
    stB.length === 1 && eq(Object.keys(stB[0]).sort(), ['book_key', 'state']) && stB[0].book_key === 'k-print');
  ok('friends state RPC refuses the owner by construction', eq(rpcStates(W, 'R', 'R'), []));
  const lockRefusal = rpcClaim(W, 'B', 'R', 'k-print');
  ok('claim lock: second claim on the same book refused with the identical shape', eq(lockRefusal, FAIL) && eq(lockRefusal, noGrant));
}

/* ---- revocation mid-claim + re-grant ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW); W.grants.set('R>B', NOW);
  const c1 = claimOk(W, 'A', 'k-print');
  NOW += 25 * HOUR;
  ok('reveal works while the grant stands (aged claim)', rpcReveal(W, 'A', 'R', c1.claim_id).kind === 'print');
  W.grants.delete('R>A');
  ok('grant revoked mid-claim: friends states vanish, claimer list reads released, reveal is dead',
    eq(rpcStates(W, 'B', 'R'), []) && rpcMine(W, 'A')[0].state === 'released' && eq(rpcReveal(W, 'A', 'R', c1.claim_id), EMPTY));
  const c2 = rpcClaim(W, 'B', 'R', 'k-print');
  ok('grant revoked mid-claim: the book frees for other granted friends', c2.ok === true);
  W.grants.set('R>A', NOW);
  ok('re-grant does NOT resurrect the revoked claim', rpcMine(W, 'A').find(x => x.claim_id === c1.claim_id).state === 'released' &&
    rpcStates(W, 'B', 'R').length === 1);
}

/* ---- caps ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW);
  W.books.R.push({ key: 'k-x1', status: 'tbr', owned: 'tobuy', format: 'ebook', wantFormat: '' },
                 { key: 'k-x2', status: 'tbr', owned: 'tobuy', format: 'audio', wantFormat: '' });
  ok('caps: two live claims against one recipient allowed', claimOk(W, 'A', 'k-print').ok && claimOk(W, 'A', 'k-ebook').ok);
  ok('caps: third live claim against the same recipient refused identically', eq(rpcClaim(W, 'A', 'R', 'k-x1'), FAIL));
  const W2 = baseWorld();
  for (let i = 1; i <= 6; i++) { prof(W2, 'R' + i); W2.links.add(pair('R' + i, 'A')); W2.grants.set('R' + i + '>A', NOW); W2.books['R' + i] = [1, 2].map(n => ({ key: 'g' + i + '-' + n, status: 'tbr', owned: 'tobuy', format: 'ebook', wantFormat: '' })); }
  let made = 0; for (let i = 1; i <= 6; i++) for (let n = 1; n <= 2; n++) if (rpcClaim(W2, 'A', 'R' + i, 'g' + i + '-' + n).ok) made++;
  ok('caps: eleventh live claim globally refused (10 made, 11th is the identical refusal)', made === 10);
}

/* ---- serve-time composition: link loss, block, self-acquire, hide, expiry ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW); W.grants.set('R>B', NOW);
  const c1 = claimOk(W, 'A', 'k-print');
  W.links.delete(pair('R', 'A'));
  ok('link loss releases at serve time (states empty, book free for B)',
    eq(rpcStates(W, 'B', 'R'), []) && rpcClaim(W, 'B', 'R', 'k-print').ok === true);
  const W2 = baseWorld();
  W2.grants.set('R>A', NOW); W2.grants.set('R>B', NOW);
  claimOk(W2, 'A', 'k-print');
  W2.blocks.add(pair('R', 'A'));
  ok('a block in either direction severs claim visibility immediately', eq(rpcStates(W2, 'B', 'R'), []));
  const W3 = baseWorld();
  W3.grants.set('R>A', NOW); W3.grants.set('R>B', NOW);
  claimOk(W3, 'A', 'k-print');
  W3.books.R.find(b => b.key === 'k-print').status = 'read';
  ok('recipient acquiring the book releases the claim at serve time (evaluated on current derivation)',
    eq(rpcStates(W3, 'B', 'R'), []) && rpcMine(W3, 'A')[0].state === 'released');
  const W4 = baseWorld();
  W4.grants.set('R>A', NOW);
  ok('hidden wishlist refuses claims like everything else', (prof(W4, 'R').hidden = ['wishlist'], eq(rpcClaim(W4, 'A', 'R', 'k-print'), FAIL)));
  const W5 = baseWorld();
  W5.grants.set('R>A', NOW); W5.grants.set('R>B', NOW);
  claimOk(W5, 'A', 'k-print');
  NOW += 45 * DAY;
  ok('45-day expiry frees the book at serve time and reads expired in the claimer list',
    rpcClaim(W5, 'B', 'R', 'k-print').ok === true && rpcMine(W5, 'A')[0].state === 'expired');
  NOW -= 45 * DAY;
}

/* ---- reveal: claim age, budgets, cycling, field scoping ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW);
  const c1 = claimOk(W, 'A', 'k-print');
  ok('first-pair claim age: reveal at claim age 0 is the identical empty refusal', eq(rpcReveal(W, 'A', 'R', c1.claim_id), EMPTY));
  NOW += 23 * HOUR + 59 * 60000;
  ok('first-pair claim age: still refused at 23h59m', eq(rpcReveal(W, 'A', 'R', c1.claim_id), EMPTY));
  NOW += 60000;
  const r1 = rpcReveal(W, 'A', 'R', c1.claim_id);
  ok('first-pair claim age: allowed at 24h; print claim reveals postal + phone and NO email',
    r1.kind === 'print' && r1.postal === 'E1C 1A1' && r1.phone === '506-555-0100' && !('email' in r1));
  ok('per-claim budget: reveals 2 and 3 on the same claim succeed',
    rpcReveal(W, 'A', 'R', c1.claim_id).kind === 'print' && rpcReveal(W, 'A', 'R', c1.claim_id).kind === 'print');
  ok('per-claim budget: the fourth reveal on one claim is refused', eq(rpcReveal(W, 'A', 'R', c1.claim_id), EMPTY));
  rpcResolve(W, 'A', c1.claim_id, 'purchased');
  const c2 = claimOk(W, 'A', 'k-ebook');
  const rE = rpcReveal(W, 'A', 'R', c2.claim_id);
  ok('prior resolved claim waives the 24h rule; ebook claim reveals ONLY the gift email',
    rE.kind === 'ebook' && rE.email === 'gifts@example.com' && !('street' in rE) && !('postal' in rE) && !('phone' in rE));
  // pair budget: 4 reveals used; burn 6 more across fresh claims, 11th pair reveal must refuse
  let burned = 0;
  for (const key of ['k-trophy', 'k-print']) {
    const cc = claimOk(W, 'A', key); if (!cc.ok) continue;
    for (let i = 0; i < 3 && burned < 6; i++) if (rpcReveal(W, 'A', 'R', cc.claim_id).kind) burned++;
    rpcResolve(W, 'A', cc.claim_id, 'released');
  }
  const cLast = claimOk(W, 'A', 'k-print');
  ok('pair budget: 10 reveals per pair per 30d — the 11th refuses even on a fresh claim, release-and-reclaim mints nothing',
    burned === 6 && eq(rpcReveal(W, 'A', 'R', cLast.claim_id), EMPTY));
  NOW -= 25 * HOUR;
}

/* ---- reveal refusal causes are one shape ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW);
  const c1 = claimOk(W, 'A', 'k-ebook');
  NOW += 25 * HOUR;
  const causes = [];
  causes.push(rpcReveal(W, 'B', 'R', c1.claim_id));               // no grant
  W.grants.set('R>B', NOW); causes.push(rpcReveal(W, 'B', 'R', c1.claim_id)); // not the claimer / no claim
  W.addresses.R.sharing = false; causes.push(rpcReveal(W, 'A', 'R', c1.claim_id)); // toggle off
  W.addresses.R.sharing = true; W.blocks.add(pair('R', 'A')); causes.push(rpcReveal(W, 'A', 'R', c1.claim_id)); // blocked
  W.blocks.delete(pair('R', 'A')); delete W.addresses.R; causes.push(rpcReveal(W, 'A', 'R', c1.claim_id)); // no address
  ok('every reveal refusal cause returns the identical empty object (A10 anti-oracle)', causes.every(x => eq(x, EMPTY)));
  NOW -= 25 * HOUR;
}

/* ---- two-tier access log ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW);
  const c1 = claimOk(W, 'A', 'k-print');
  NOW += 25 * HOUR;
  rpcReveal(W, 'A', 'R', c1.claim_id);
  ok('log tier 1: owner sees nothing before 72h', eq(rpcLogMine(W, 'R'), []));
  NOW += 71 * HOUR;
  ok('log tier 1: still nothing at 71h', eq(rpcLogMine(W, 'R'), []));
  NOW += 1 * HOUR;
  const fact = rpcLogMine(W, 'R');
  ok('log tier 1: at 72h the fact only — timestamp, no claimer, no book',
    fact.length === 1 && fact[0].viewer_id === null && fact[0].book_key === null && typeof fact[0].revealed_at === 'number');
  rpcResolve(W, 'A', c1.claim_id, 'purchased');
  const detail = rpcLogMine(W, 'R');
  ok('log tier 2: claim resolution reveals claimer + book immediately',
    detail[0].viewer_id === 'A' && detail[0].book_key === 'k-print');
  const W2 = baseWorld();
  W2.grants.set('R>A', NOW);
  const cc = claimOk(W2, 'A', 'k-print');
  NOW += 25 * HOUR; rpcReveal(W2, 'A', 'R', cc.claim_id);
  NOW += 14 * DAY;
  ok('log tier 2: an unresolved claim\'s detail still lands at 14 days',
    rpcLogMine(W2, 'R')[0].viewer_id === 'A');
  NOW -= (25 * HOUR + 14 * DAY + 72 * HOUR);
}

/* ---- recipient visibility setting ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW);
  claimOk(W, 'A', 'k-print');
  ok('recipient setting OFF (default): the recipient reads zero claim data', eq(rpcForRecipient(W, 'R'), []));
  prof(W, 'R').claimsVisible = true;
  const view = rpcForRecipient(W, 'R');
  ok('recipient setting ON: own books only, payload exactly book + claimer + state, no address data',
    view.length === 1 && eq(Object.keys(view[0]).sort(), ['book_key', 'claimer_id', 'state']) && view[0].claimer_id === 'A');
}

/* ---- minors matrix ---- */
{
  const W = baseWorld();
  prof(W, 'T').band = 'teen';
  ok('minors: a teen account cannot store an address', eq(rpcUpsert(W, 'T', ADDR), FAIL));
  ok('minors: a teen without the recipient\'s grant gets the identical claim refusal as anyone ungranted',
    eq(rpcClaim(W, 'T', 'R', 'k-print'), FAIL));
  W.grants.set('R>T', NOW);
  const tc = rpcClaim(W, 'T', 'R', 'k-print');
  NOW += 25 * HOUR;
  ok('minors: a teen WITH the grant claims and reveals under the standard predicates and budgets',
    tc.ok === true && rpcReveal(W, 'T', 'R', tc.claim_id).kind === 'print');
  const W2 = baseWorld();
  prof(W2, 'R').band = 'teen';
  delete W2.addresses.R; // the storage rule: a teen row can never exist
  ok('minors: claiming FOR a teen recipient requires the teen\'s own grant like anyone\'s',
    eq(rpcClaim(W2, 'A', 'R', 'k-print'), FAIL));
  W2.grants.set('R>A', NOW);
  const ac = rpcClaim(W2, 'A', 'R', 'k-print');
  NOW += 25 * HOUR;
  ok('minors: the reveal for a teen recipient is empty by the storage rule (no address can exist)',
    ac.ok === true && eq(rpcReveal(W2, 'A', 'R', ac.claim_id), EMPTY));
  NOW -= 50 * HOUR;
}

/* ---- trophy wants + own-state edges ---- */
{
  const W = baseWorld();
  W.grants.set('R>A', NOW);
  const t = rpcClaim(W, 'A', 'R', 'k-trophy');
  ok('trophy wants are claimable; the format kind follows the WANTED format (hardcover → print)',
    t.ok === true && t.format_kind === 'print');
  ok('a merely-owned book is not giftable', eq(rpcClaim(W, 'A', 'R', 'k-owned'), FAIL));
  ok('mark purchased on a live claim resolves it; a second resolution refuses',
    rpcResolve(W, 'A', t.claim_id, 'purchased').ok === true && eq(rpcResolve(W, 'A', t.claim_id, 'purchased'), FAIL));
}

/* ================= client pins (js/243 + integration) ================= */
{
  const fsx = require('fs'), pathx = require('path'), vm = require('vm');
  const read = p => fsx.readFileSync(pathx.join(APP_DIR, p), 'utf8');
  const g = read('js/243-gifts.js');
  ok('client: fail-closed probe is the profiles gift_claims_visible footprint, Marginalia pattern',
    /from\('profiles'\)\.select\('gift_claims_visible'\)/.test(g) &&
    /42703/.test(g) && /PGRST202/.test(g) && /giftTableMissing = true/.test(g));
  ok('client: A10 line is the spec\'s exact text and is the ONLY details fallback',
    g.includes("Delivery details aren't shared for this gift.") &&
    (g.match(/GIFT_NO_DETAILS_LINE/g) || []).length >= 3);
  ok('client: retailer links are the five tagless search URLs — no tags, no tracking, no prices',
    g.includes('https://www.indigo.ca/en-ca/search?q=') &&
    g.includes('https://www.amazon.ca/s?k=') &&
    g.includes('https://www.kobo.com/ca/en/search?query=') &&
    g.includes('https://libro.fm/search?q=') &&
    !/[?&](tag|ref|aff|affiliate)=|utm_/i.test(g) &&
    /GIFT_RETAILER_DEFAULTS = \{ print: 'indigo', ebook: 'kobo', audio: 'libro' \}/.test(g));
  ok('client: retailer choice is a roamed prefs key, registered in js/229 like bookdress',
    g.includes("const GIFT_RETAILERS_KEY = 'cozylibram.giftretailers'") &&
    read('js/229-user-state.js').includes("'cozylibram.giftretailers'"));
  ok('client: claim flow is can_gift → states → claim; refusal repaints with no sheet and no error text',
    /giftRpc\('gift_can_gift'/.test(g) && /giftRpc\('gift_claim_states_for'/.test(g) &&
    /giftRpc\('gift_claim'/.test(g) && /no sheet, no error text/.test(g));
  ok('client: settings grants ride the gift_grants table directly (recipient-managed RLS), teen band hides the address section',
    /from\('gift_grants'\)\.insert/.test(g) && /from\('gift_grants'\)\.delete/.test(g) &&
    /giftTeenBand\(\)/.test(g) && /privacyState\(\)\.band === 'teen'|s\.band === 'teen'/.test(g));
  ok('client: recipient claims list renders only behind the opt-in and names book + claimer only',
    /claimsOn = priv\.giftClaims === true/.test(g) && /gift_claims_for_recipient/.test(g));
  const coven = read('js/195-coven.js');
  ok('client: coven reads gift_claims_visible with the strict OFF default and folds it into saves with the column-drop retry',
    /gift_claims_visible === true/.test(coven) &&
    /row\.gift_claims_visible = !!circleGiftClaimsValue/.test(coven) &&
    /delete row\.gift_claims_visible/.test(coven));
  ok('client: module is registered in index.html and the sw.js precache list',
    read('index.html').includes('js/243-gifts.js') && read('sw.js').includes("'243-gifts.js'"));
  ok('client: own-shelf and modal Buy slots exist and route to the minimal sheet',
    /data-gift-buy-slot/.test(read('js/190-wishlist.js')) &&
    /f-giftbuy/.test(read('js/150-modal-discovery.js')) &&
    /openGiftBuySheet/.test(g));

  // Functional: the key mirror, extracted and run.
  const sandbox = { window: {}, console, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, navigator: {} };
  vm.createContext(sandbox);
  const src = g.split('/* ---------- the claim display cache')[0];
  vm.runInContext(src + '\n;this.__gift = { giftBookKey, giftRetailerLink, giftIsbn13 };', sandbox);
  const G = sandbox.__gift;
  ok('client: giftBookKey matches the server key on vectors (isbn13 passthrough, isbn-10 conversion, ta: fallback, data-wrapped rows)',
    G.giftBookKey({ isbn: '9780593183649', title: 'X', authors: ['A'] }) === 'isbn:9780593183649' &&
    G.giftBookKey({ isbn: '0306406152', title: 'X', authors: ['A'] }) === 'isbn:9780306406157' &&
    G.giftBookKey({ isbn: '', title: ' The Spy ', authors: ['Clive Cussler', 'Grant Blackwood'] }) === 'ta:the spy|clive cussler' &&
    G.giftBookKey({ isbn: '', title: 'Solo', authors: 'Lone Author' }) === 'ta:solo|lone author' &&
    G.giftBookKey({ data: { isbn: '9780593183649', title: 'X', authors: ['A'] }, isbn: null }) === 'isbn:9780593183649');
  ok('client: retailer link uses the ISBN when present and "Title Author" when not',
    G.giftRetailerLink({ isbn: '9780593183649', title: 'T', authors: ['A'] }, 'print', 'indigo') === 'https://www.indigo.ca/en-ca/search?q=9780593183649' &&
    G.giftRetailerLink({ isbn: '', title: 'The Spy', authors: ['Clive Cussler'] }, 'ebook', 'kobo') === 'https://www.kobo.com/ca/en/search?query=The%20Spy%20Clive%20Cussler');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
