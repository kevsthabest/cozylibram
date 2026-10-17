// Circle permissions Phase 2 (v524): age band + content shield.
//
// The rulings under test:
// - The band lives ONLY in user_state (privacy section) — never in a
//   profiles row, never in a friend-visible payload, never displayed.
// - Teen starting positions apply EXACTLY ONCE (first teen declaration):
//   share_library/share_bio/share_activity off (per-shelf hiding kept),
//   shield on. Later saves / re-declarations never stomp user changes.
// - The shield (viewer-side): high-spice = effective spice >= 4 on the
//   app's own scale (4 "Explicit" / 5 "Filthy"); effective spice is the
//   record's ratings.spice, else the work baseline (manual > detected).
//   UNKNOWN spice is NOT high-spice. Shielded: friend-grid covers blur
//   + spice badges gone; "You'd love this" excludes adult titles;
//   circle stats exclude friends' adult titles and the Spiciest Shelf
//   award; the viewer's OWN books are never filtered. Shield off =
//   byte-identical behavior to v522.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in circle-shield tests'); };
window.confirm = () => true;

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });
const PRIVACY_KEY = 'cozylibram.privacy.v1';
const resetPrivacy = () => window.localStorage.removeItem(PRIVACY_KEY);

// ---- stub supabase client: profiles + projection + books + works + user_state ----
const mkStub = () => {
  const db = { circle_links: [], profiles: {}, books: [], works: [], user_state: {} };
  const projectPublic = (p) => {
    const out = { user_id: p.user_id, first_name: p.first_name || '', last_name: p.last_name || '',
      avatar_id: p.avatar_id || '', avatar_path: p.avatar_path || '',
      share_library: p.share_library !== false, share_bio: p.share_bio !== false,
      share_activity: p.share_activity === true };
    if (out.share_bio) {
      if (p.bio) out.bio = p.bio;
      if (Array.isArray(p.fav_genres) && p.fav_genres.length) out.fav_genres = p.fav_genres.slice();
    }
    return out;
  };
  const rowsOf = (n) => n === 'profiles' ? Object.values(db.profiles)
    : n === 'circle_profiles' ? Object.values(db.profiles).map(projectPublic)
    : n === 'user_state' ? Object.values(db.user_state)
    : (db[n] || []);
  const stub = { db, signUpArgs: null,
    auth: { signUp: async (args) => { stub.signUpArgs = args; return { data: { session: null, user: { id: 'user-new' } }, error: null }; } },
    from(name) {
      return {
        select(cols) {
          const q = { conds: [], ins: [],
            eq(c, v) { q.conds.push([c, v]); return q; },
            in(c, vs) { q.ins.push([c, vs]); return q; },
            _run() {
              return rowsOf(name).filter(r => q.conds.every(([c, v]) => r[c] === v) &&
                q.ins.every(([c, vs]) => vs.indexOf(r[c]) !== -1));
            },
            maybeSingle() { const rs = q._run(); return Promise.resolve({ data: rs[0] || null, error: null }); },
            then(res, rej) { try { return res({ data: q._run(), error: null }); } catch (e) { return rej(e); } },
          };
          return q;
        },
        upsert(row) {
          if (name === 'profiles') db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row);
          if (name === 'user_state') db.user_state[row.user_id] = Object.assign({}, db.user_state[row.user_id], row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return stub;
};

const ME = 'user-me', FRIEND = 'user-friend';
const stub = mkStub();
const useAs = (uid) => runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';');
const NOW = new Date().toISOString();

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;

  // ---- fixtures ----
  stub.db.profiles[ME] = { user_id: ME, first_name: 'Me', last_name: 'Myself', gender: 'f',
    avatar_id: 'raven', avatar_path: '', share_library: true, hidden_shelves: ['dnf'],
    bio: 'My bio', fav_genres: ['Romantasy'], share_bio: true, share_activity: true,
    updated_at: '2026-10-01T00:00:00Z' };
  stub.db.profiles[FRIEND] = { user_id: FRIEND, first_name: 'Fran', last_name: 'Friend', gender: 'f',
    avatar_id: 'moon', avatar_path: '', share_library: true, hidden_shelves: [],
    bio: 'Fran bio', fav_genres: ['Gothic'], share_bio: true, share_activity: true,
    updated_at: '2026-10-01T00:00:00Z' };
  stub.db.circle_links.push({ requester_id: ME, addressee_id: FRIEND, status: 'accepted', created_at: '2026-09-01T00:00:00Z' });
  const bookRow = (user_id, data) => ({ user_id, book_id: data.id, isbn: null, data });
  const fbook = (id, title, author, spice, rating, extra) => bookRow(FRIEND, Object.assign({
    id, title, authors: [author], status: 'read', myRating: rating,
    ratings: spice ? { spice } : {}, axes: spice ? ['spice'] : [],
    cover: 'https://x/' + id + '.jpg', dateFinished: NOW, categories: ['Fiction / Romance'],
  }, extra || {}));
  stub.db.books.push(fbook('hot1', 'Filthy Book', 'A One', 5, 5));       // record spice 5
  stub.db.books.push(fbook('warm1', 'Steamy Book', 'A Two', 3, 5));       // record spice 3 (below threshold)
  stub.db.books.push(fbook('extra1', 'Extra Spicy', 'A Five', 4, 4));    // record spice 4 (boundary)
  stub.db.books.push(fbook('base1', 'Baseline Book', 'A Three', 0, 5));  // work baseline 4 (detected)
  stub.db.books.push(fbook('unk1', 'Unknown Book', 'A Four', 0, 5));     // no spice data anywhere
  // work rows, keyed by the app's own norms
  const workRow = (title, author, det, man) => {
    const k = probe('workKeysFor({ title: ' + JSON.stringify(title) + ', authors: [' + JSON.stringify(author) + '] })');
    return { title_norm: k.titleNorm, author_norm: k.authorNorm, spice_detected: det, spice_manual: man };
  };
  stub.db.works.push(workRow('Baseline Book', 'A Three', 4, null));
  stub.db.works.push(workRow('Manual Book', 'A Six', 1, 5));   // manual overrides detected
  stub.db.works.push(workRow('Zero Book', 'A Seven', 5, 0));   // manual 0 overrides detected 5

  useAs(ME);
  resetPrivacy();

  /* ---------- A. registration + payload hygiene ---------- */
  // R1 repoint (migration plan §9.3): js/230's tag is a module tag since
  // its ESM conversion; the registration assertion accepts either exact
  // tag form — the same assertion, coverage unchanged.
  ok('index.html registers js/230-privacy.js',
    html.includes('<script src="js/230-privacy.js"></script>') ||
    html.includes('<script type="module" src="js/230-privacy.js"></script>'));
  const swText = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  ok('sw.js precaches 230-privacy.js', swText.includes("'230-privacy.js'"));
  const dflt = probe('privacyState()');
  ok('defaults: band unset, shield off (adult defaults)', dflt.band === null && dflt.shield === false && dflt.teenDefaultsApplied === false);
  probe('setShield(true)');
  const collected = probe('userStateCollect()');
  ok('band/shield never join the settings snapshot', !(PRIVACY_KEY in collected));
  const collPriv = probe('userStateCollectPrivacy()');
  ok('privacy rides its own user_state section', !!collPriv && !!collPriv.value && collPriv.value.shield === true && collPriv.value.band === null);
  const pFriend = await probe('circleFriendProfile("' + FRIEND + '")'); await tick();
  ok('friend payload has NO band fields', pFriend && !('band' in pFriend) && !('age_band' in pFriend));
  runInWindow('saveProfile({ firstName: "Me", lastName: "Myself", gender: "", avatar: { type: "letter" }, avatarCloudPath: "", updatedAt: Date.now(), bio: "B", favGenres: [] });');
  await probe('pushCloudProfile(loadProfile())'); await tick(3);
  ok('profiles upsert carries NO band', !('band' in stub.db.profiles[ME]) && !('age_band' in stub.db.profiles[ME]));
  probe('setShield(false)');

  /* ---------- B. spice resolution ---------- */
  ok('threshold is 4 (Explicit on the app scale)', probe('SHIELD_SPICE_MIN') === 4);
  const baseBook = { title: 'Baseline Book', authors: ['A Three'], ratings: {} };
  const mapBase = await probe('WorkStore.spiceMapFor([' + JSON.stringify(baseBook) + '])');
  ok('spiceMapFor resolves the work baseline', mapBase[probe('shieldWorkKey(' + JSON.stringify(baseBook) + ')')] === 4);
  ok('record spice wins over baseline', probe('shieldSpiceOf({ title: "Baseline Book", authors: ["A Three"], ratings: { spice: 2 } }, ' + JSON.stringify(mapBase) + ')') === 2);
  ok('baseline applies when the record is unrated', probe('shieldIsHighSpice(' + JSON.stringify(baseBook) + ', ' + JSON.stringify(mapBase) + ')') === true);
  const manBook = { title: 'Manual Book', authors: ['A Six'], ratings: {} };
  const mapMan = await probe('WorkStore.spiceMapFor([' + JSON.stringify(manBook) + '])');
  ok('manual baseline overrides detected', mapMan[probe('shieldWorkKey(' + JSON.stringify(manBook) + ')')] === 5);
  const zeroBook = { title: 'Zero Book', authors: ['A Seven'], ratings: {} };
  const mapZero = await probe('WorkStore.spiceMapFor([' + JSON.stringify(zeroBook) + '])');
  ok('manual 0 overrides a high detected value (not high-spice)',
    probe('shieldIsHighSpice(' + JSON.stringify(zeroBook) + ', ' + JSON.stringify(mapZero) + ')') === false);
  ok('spice 3 is NOT high (Steamy stays visible)', probe('shieldIsHighSpice({ ratings: { spice: 3 } }, {})') === false);
  ok('spice 4 IS high (Explicit)', probe('shieldIsHighSpice({ ratings: { spice: 4 } }, {})') === true);
  ok('unknown spice is NOT high-spice', probe('shieldSpiceOf({ title: "Nope", authors: ["Nobody"], ratings: {} }, {})') === null &&
    probe('shieldIsHighSpice({ title: "Nope", authors: ["Nobody"], ratings: {} }, {})') === false);

  /* ---------- C. defaults by band ---------- */
  const setRow = (share, bio, act) => { stub.db.profiles[ME].share_library = share; stub.db.profiles[ME].share_bio = bio; stub.db.profiles[ME].share_activity = act; stub.db.profiles[ME].hidden_shelves = ['dnf']; };
  resetPrivacy(); setRow(true, true, true);
  await probe('setAgeBand("adult")'); await tick();
  ok('adult declaration writes NO toggles', stub.db.profiles[ME].share_library === true && stub.db.profiles[ME].share_bio === true && stub.db.profiles[ME].share_activity === true);
  ok('adult declaration records the band, shield stays off', probe('privacyState()').band === 'adult' && probe('privacyState()').shield === false);

  resetPrivacy(); setRow(true, true, true);
  await probe('setAgeBand("teen")'); await tick();
  ok('first teen: shelves toggle off', stub.db.profiles[ME].share_library === false);
  ok('first teen: bio toggle off', stub.db.profiles[ME].share_bio === false);
  ok('first teen: activity toggle off', stub.db.profiles[ME].share_activity === false);
  ok('first teen: per-shelf hiding preserved', (stub.db.profiles[ME].hidden_shelves || []).join(',') === 'dnf');
  ok('first teen: shield on + defaults marked applied', probe('privacyState()').shield === true && probe('privacyState()').teenDefaultsApplied === true);

  // the user opens everything back up; nothing may stomp it afterwards
  await probe('circleSavePrivacy(true, ["dnf"], true, false)'); probe('setShield(false)');
  await probe('setAgeBand("adult")'); await probe('setAgeBand("teen")'); await tick();
  ok('re-declaring teen does NOT re-close sharing', stub.db.profiles[ME].share_library === true && stub.db.profiles[ME].share_bio === true);
  ok('re-declaring teen does NOT re-flip the shield', probe('privacyState()').shield === false);

  // pending retry: band recorded, write never landed (offline signup)
  resetPrivacy(); setRow(true, true, true);
  runInWindow('localStorage.setItem(' + JSON.stringify(PRIVACY_KEY) + ', JSON.stringify({ band: "teen", shield: true, teenDefaultsApplied: false, bandSetAt: 1 }))');
  const landed = await probe('applyPendingTeenDefaults()'); await tick();
  ok('pending teen defaults land at sign-in', landed === true && stub.db.profiles[ME].share_library === false && stub.db.profiles[ME].share_bio === false && stub.db.profiles[ME].share_activity === false);
  ok('pending defaults are one-shot', (await probe('applyPendingTeenDefaults()')) === false);

  // metadata adoption is a one-time seed
  resetPrivacy(); setRow(true, true, true);
  await probe('adoptSignupBand({ user_metadata: { age_band: "teen" } })'); await tick();
  ok('signup metadata adopts the band + teen defaults', probe('privacyState()').band === 'teen' && stub.db.profiles[ME].share_library === false);
  await probe('setAgeBand("adult")');
  await probe('adoptSignupBand({ user_metadata: { age_band: "teen" } })'); await tick();
  ok('stale signup metadata never stomps a later band change', probe('privacyState()').band === 'adult');

  // signed-out declaration: shield applies locally, profiles write defers
  useAs(null); resetPrivacy();
  await probe('setAgeBand("teen")'); await tick();
  const soState = probe('privacyState()');
  ok('signed-out teen declaration: shield on locally, write pending', soState.shield === true && soState.teenDefaultsApplied === false);
  useAs(ME);

  /* ---------- D. shield filtering per surface ---------- */
  // fixtures for stats: my own high-spice book must NEVER be filtered
  runInWindow('library = [{ id: "own1", title: "My Hot Book", authors: ["Me"], status: "read", myRating: 5, ratings: { spice: 5 }, axes: ["spice"], dateFinished: ' + JSON.stringify(NOW) + ', categories: ["Fiction / Romance"] }];');
  setRow(true, true, true); stub.db.profiles[FRIEND].share_activity = true;

  probe('setShield(false)');
  const recosOff = await probe('loadRecos()'); await tick();
  const offTitles = recosOff.map(r => r.book.title);
  ok('shield OFF: recos include every 4★+ friend book', ['Filthy Book', 'Steamy Book', 'Extra Spicy', 'Baseline Book', 'Unknown Book'].every(t => offTitles.indexOf(t) !== -1));
  const statsOff = await probe('loadCovenStats()'); await tick();
  const frOff = (statsOff.people || []).find(p => p.id === FRIEND);
  ok('shield OFF: stats count all friend books', frOff && frOff.stats.finished === 5);
  ok('shield OFF: Spiciest Shelf award present', (statsOff.awards || []).some(a => a.label === 'Spiciest Shelf'));

  probe('setShield(true)');
  const recosOn = await probe('loadRecos()'); await tick();
  const onTitles = recosOn.map(r => r.book.title);
  ok('shield ON: recos exclude record-spice 5 and boundary 4', onTitles.indexOf('Filthy Book') === -1 && onTitles.indexOf('Extra Spicy') === -1);
  ok('shield ON: recos exclude baseline-spice 4', onTitles.indexOf('Baseline Book') === -1);
  ok('shield ON: recos keep steamy (3) + unknown', onTitles.indexOf('Steamy Book') !== -1 && onTitles.indexOf('Unknown Book') !== -1);
  const statsOn = await probe('loadCovenStats()'); await tick();
  const frOn = (statsOn.people || []).find(p => p.id === FRIEND);
  ok('shield ON: stats exclude friends’ adult titles from aggregates', frOn && frOn.stats.finished === 2);
  ok('shield ON: no trace of adult titles in the digest payload', JSON.stringify(statsOn).indexOf('Filthy Book') === -1 && JSON.stringify(statsOn).indexOf('Baseline Book') === -1);
  ok('shield ON: Spiciest Shelf award suppressed', !(statsOn.awards || []).some(a => a.label === 'Spiciest Shelf'));
  const meOn = (statsOn.people || []).find(p => p.id === 'me');
  ok('shield ON: my OWN high-spice book is never filtered', meOn && meOn.stats.finished === 1 && JSON.stringify(meOn.stats.books).indexOf('My Hot Book') !== -1);

  // friend shelf grid: blur + badge hiding
  runInWindow('circFriend = { id: "' + FRIEND + '", name: "Fran Friend" }; circShelf = "all";');
  probe('renderCovenFriend()'); await tick(8);
  const grid = window.document.querySelector('#view .grid');
  ok('friend grid renders', !!grid);
  const cardOf = (title) => Array.from(window.document.querySelectorAll('#view .book-card')).find(c => (c.querySelector('h3') || {}).textContent === title);
  ok('shield ON: record-spice cover blurred + tagged', !!cardOf('Filthy Book') && !!cardOf('Filthy Book').querySelector('.cover-wrap.shield-blur') && !!cardOf('Filthy Book').querySelector('.shield-note'));
  ok('shield ON: baseline-spice cover blurred once the map lands', !!cardOf('Baseline Book') && !!cardOf('Baseline Book').querySelector('.cover-wrap.shield-blur'));
  ok('shield ON: steamy + unknown covers stay clear', !!cardOf('Steamy Book') && !cardOf('Steamy Book').querySelector('.shield-blur') && !!cardOf('Unknown Book') && !cardOf('Unknown Book').querySelector('.shield-blur'));
  ok('shield ON: NO spice badges anywhere in the friend grid', window.document.querySelectorAll('#view .badge.spice').length === 0);
  probe('setShield(false)');
  probe('renderCovenFriendMain()'); await tick(3);
  ok('shield OFF: no blur, spice badges back (v522 behavior)', !window.document.querySelector('#view .shield-blur') && window.document.querySelectorAll('#view .badge.spice').length >= 1);

  // Discover reco cards: blur known-high candidates only
  const recoBox = window.document.createElement('div');
  recoBox.id = 'disc-reco';
  window.document.body.appendChild(recoBox);
  const candBase = { title: 'Baseline Book', authors: ['A Three'], cover: 'https://x/base1.jpg', hcId: 91 };
  const candUnk = { title: 'Unknown Book', authors: ['A Four'], cover: 'https://x/unk1.jpg', hcId: 92 };
  const candMap = await probe('WorkStore.spiceMapFor([' + JSON.stringify(candBase) + ', ' + JSON.stringify(candUnk) + '])');
  probe('setShield(true)');
  probe('renderRecoResults([{ c: ' + JSON.stringify(candBase) + ', sim: 0.9 }, { c: ' + JSON.stringify(candUnk) + ', sim: 0.8 }], [], true, ' + JSON.stringify(candMap) + ')');
  ok('Discover: known high-spice candidate cover blurred', recoBox.querySelectorAll('.shield-blur').length === 1 && recoBox.innerHTML.indexOf('Shielded') !== -1);
  probe('setShield(false)');
  probe('renderRecoResults([{ c: ' + JSON.stringify(candBase) + ', sim: 0.9 }], [], true, ' + JSON.stringify(candMap) + ')');
  ok('Discover: shield off = no blur (v522 behavior)', recoBox.querySelectorAll('.shield-blur').length === 0);

  /* ---------- E. the shield toggle (v590: moved out of the sharing
     panel into Settings → Reading, with the "What you see" trio — it is
     the one INCOMING control; its user_state home is unchanged) ---------- */
  probe('setShield(true)');
  const shieldHTML = probe('shieldSegHTML("rd")');
  ok('shield seg renders with its label', shieldHTML.indexOf('id="rd-shield"') !== -1 && shieldHTML.indexOf('Content shield') !== -1);
  const panelHTML2 = probe('circlePrivacyPanelHTML(' + JSON.stringify({ share: true, hidden: [], bio: true, activity: false }) + ', "st", [])');
  ok('the sharing panel no longer carries the shield (it is not a sharing posture)', panelHTML2.indexOf('Content shield') === -1);
  const mount = window.document.createElement('div');
  mount.innerHTML = shieldHTML;
  window.document.body.appendChild(mount);
  probe('wireShieldSeg(document.body.lastElementChild, "rd")');
  const rowBefore = JSON.stringify(stub.db.profiles[ME]);
  mount.querySelector('#rd-shield [data-v="0"]').click(); await tick(3);
  ok('shield toggle writes user_state state', probe('privacyState()').shield === false);
  ok('shield toggle NEVER writes the profiles row', JSON.stringify(stub.db.profiles[ME]) === rowBefore);
  mount.querySelector('#rd-shield [data-v="1"]').click(); await tick(3);
  ok('shield toggle back on', probe('privacyState()').shield === true);

  /* ---------- E2. the gift opt-in fence (hybrid) ----------
   * The gift cluster lives on the Profile view now, so the Settings
   * door wires the panel with NO gift seg mounted. The panel seeds its
   * gift state from the loaded profile, so a save from that door folds
   * the LOADED value back into the row — it must neither reset an
   * opt-in nor coerce the opt-in on. (The Advisor verified this fence
   * in v590; the hybrid must not reopen it.) The row starts WITHOUT
   * the key, so only a value the save actually writes can satisfy
   * either direction. */
  const fencePriv = { share: true, hidden: [], bio: true, activity: false, recos: true, buddy: true, marginalia: true, giftClaims: true };
  delete stub.db.profiles[ME].gift_claims_visible;
  const fenceHost = window.document.createElement('div');
  fenceHost.innerHTML = probe('circlePrivacyPanelHTML(' + JSON.stringify(fencePriv) + ', "st", [])');
  window.document.body.appendChild(fenceHost);
  probe('wireCirclePrivacyPanel(document.body.lastElementChild, ' + JSON.stringify(fencePriv) + ', "st")');
  fenceHost.querySelector('#st-share [data-v="0"]').click(); await tick(4);
  ok('fence: a panel save with no gift seg mounted writes back the loaded opt-in (true)',
    stub.db.profiles[ME].gift_claims_visible === true);
  const fencePriv2 = Object.assign({}, fencePriv, { share: false, giftClaims: false });
  delete stub.db.profiles[ME].gift_claims_visible;
  fenceHost.remove(); // duplicate seg ids would shadow the second host's
  const fenceHost2 = window.document.createElement('div');
  fenceHost2.innerHTML = probe('circlePrivacyPanelHTML(' + JSON.stringify(fencePriv2) + ', "sf", [])');
  window.document.body.appendChild(fenceHost2);
  probe('wireCirclePrivacyPanel(document.body.lastElementChild, ' + JSON.stringify(fencePriv2) + ', "sf")');
  fenceHost2.querySelector('#sf-share [data-v="1"]').click(); await tick(4);
  ok('fence: a panel save with no gift seg mounted never coerces the opt-in on (false stays false)',
    stub.db.profiles[ME].gift_claims_visible === false);
  fenceHost2.remove();

  /* ---------- F. user_state privacy section sync ---------- */
  resetPrivacy();
  runInWindow('localStorage.setItem(' + JSON.stringify(PRIVACY_KEY) + ', JSON.stringify({ band: "teen", shield: true, teenDefaultsApplied: true, bandSetAt: 42 }))');
  ['cozylibram.userstate.v1.' + ME, 'cozylibram.userstate.owner'].forEach(k => window.localStorage.removeItem(k));
  stub.db.user_state = {};
  await probe('userStatePull()'); await probe('userStatePush()'); await tick();
  const srvRow = stub.db.user_state[ME] || {};
  ok('privacy section seeds into privacy_state', !!srvRow.privacy_state && srvRow.privacy_state._at > 0 && srvRow.privacy_state.value.band === 'teen' && srvRow.privacy_state.value.shield === true);
  ok('privacy value never rides the settings snapshot', !JSON.stringify(srvRow.settings || {}).includes('teen'));
  window.localStorage.removeItem(PRIVACY_KEY);
  ['cozylibram.userstate.v1.' + ME, 'cozylibram.userstate.owner'].forEach(k => window.localStorage.removeItem(k));
  await probe('userStatePull()'); await tick();
  const adopted = probe('privacyState()');
  ok('privacy section adopts on a second device', adopted.band === 'teen' && adopted.shield === true && adopted.teenDefaultsApplied === true);

  /* ---------- G. signup + profile UI ---------- */
  useAs(null); resetPrivacy();
  probe('renderGateSignup()'); await tick(2);
  ok('signup shows the age-group picker', !!window.document.querySelector('#gs-band [data-b="teen"]') && !!window.document.querySelector('#gs-band [data-b="adult"]'));
  ok('signup states the 13+ floor', (window.document.querySelector('.gate-card') || {}).textContent.indexOf('13 and up') !== -1);
  const setField = (id, v) => { window.document.getElementById(id).value = v; };
  setField('gs-first', 'New'); setField('gs-last', 'Reader');
  setField('gs-handle', 'new_reader'); // v551: the handle is a required signup field
  setField('gs-email', 'new@x.y'); setField('gs-pass', 'secret1'); setField('gs-pass2', 'secret1');
  window.document.getElementById('gs-create').click(); await tick(2);
  ok('signup requires an age-group choice', (window.document.getElementById('gs-status') || {}).textContent.indexOf('age group') !== -1 && !stub.signUpArgs);
  window.document.querySelector('#gs-band [data-b="teen"]').click();
  window.document.getElementById('gs-create').click(); await tick(3);
  ok('signup sends the band in user_metadata', !!stub.signUpArgs && stub.signUpArgs.options.data.age_band === 'teen');
  const suState = probe('privacyState()');
  ok('signup records the band on-device at once (shield on, profiles write pending)', suState.band === 'teen' && suState.shield === true && suState.teenDefaultsApplied === false);

  // Hybrid: the account form renders on the Profile view again (it
  // renders signed-out too, as the pre-v590 view did). Sign back in as
  // the test user — the band under test is device state, not the
  // profile's, so whose form it is doesn't matter.
  useAs(ME);
  probe("view = 'profile'; renderProfile();"); await tick(2);
  ok('account form shows the band picker with teen active', !!window.document.querySelector('#pf-band [data-b="teen"].active'));
  window.document.querySelector('#pf-band [data-b="adult"]').click(); await tick(3);
  ok('band picker updates the band via user_state (instant apply in the account form)', probe('privacyState()').band === 'adult');
  ok('profile row still carries NO band', !('band' in stub.db.profiles[ME]) && !('age_band' in stub.db.profiles[ME]));

  /* ---------- H. friend preview modal: the cover is a shared-view cover ---------- */
  // Advisor ruling (v524): the modal's DATA is metadata, but its cover in
  // the friend flow functions as a shared-view cover, which the shield
  // promises to blur — openCovenBook blanks it on the transient copy.
  useAs(ME);
  runInWindow('circFriend = { id: "' + FRIEND + '", name: "Fran Friend" }; circSpiceMap = {}; window.__capT = null; openPreviewModal = function(t, opts) { window.__capT = t; };');
  const modalHot = { id: 'hot1', title: 'Filthy Book', authors: ['A One'], status: 'read', myRating: 5, ratings: { spice: 5 }, axes: ['spice'], cover: 'https://x/hot1.jpg', categories: ['Fiction / Romance'] };
  const modalWarm = { id: 'warm1', title: 'Steamy Book', authors: ['A Two'], status: 'read', myRating: 5, ratings: { spice: 3 }, axes: ['spice'], cover: 'https://x/warm1.jpg', categories: ['Fiction / Romance'] };
  const modalBase = { id: 'base1', title: 'Baseline Book', authors: ['A Three'], status: 'read', myRating: 5, ratings: {}, cover: 'https://x/base1.jpg', categories: ['Fiction / Romance'] };
  probe('setShield(true)');
  probe('openCovenBook(' + JSON.stringify(modalHot) + ')');
  const capHot = probe('window.__capT');
  ok('modal: shielded + high-spice → transient cover blanked (placeholder renders)', !!capHot && capHot.cover === '');
  ok('modal: blanking hits only the transient copy — source book keeps its cover', modalHot.cover === 'https://x/hot1.jpg');
  probe('openCovenBook(' + JSON.stringify(modalWarm) + ')');
  const capWarm = probe('window.__capT');
  ok('modal: shielded + not-high-spice → cover intact', !!capWarm && capWarm.cover === 'https://x/warm1.jpg');
  const modalMap = await probe('shieldSpiceMapFor([' + JSON.stringify(modalBase) + '])');
  runInWindow('circSpiceMap = ' + JSON.stringify(modalMap) + ';');
  probe('openCovenBook(' + JSON.stringify(modalBase) + ')');
  const capBase = probe('window.__capT');
  ok('modal: shielded + baseline-spice 4 → transient cover blanked', !!capBase && capBase.cover === '');
  runInWindow('circSpiceMap = {};');
  probe('setShield(false)');
  probe('openCovenBook(' + JSON.stringify(modalHot) + ')');
  const capOff = probe('window.__capT');
  ok('modal: shield OFF → cover intact', !!capOff && capOff.cover === 'https://x/hot1.jpg');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
