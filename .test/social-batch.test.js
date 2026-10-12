// v496 social batch (#135-#141): community warnings idempotency, overlay
// token round-trips, nudge guards, validate-before-rate-limit, survey sheet
// overlay registration, concurrent friend fetches, bounded work resolution.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function buildDom() {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };
  require('./harness').loadApp(window);
  return window;
}

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- #135: ccEnrichWarnings is idempotent, sets no flag ----------
  {
    const window = buildDom();
    let rows = [{ book_key: 'bk:b1', status: 'accepted', trigger_taxonomy: { label: 'Violence' } }];
    window.bookKeyFor = (b) => 'bk:' + b.id;
    window.cloudClient = async () => ({
      from: () => ({
        select: () => ({
          eq: (col, val) => ({
            eq: (col2, val2) => Promise.resolve({
              data: rows.filter(r => r[col] === val && r[col2] === val2), error: null
            })
          })
        })
      })
    });
    const book = { id: 'b1', title: 'T', contentWarnings: [] };
    await window.ccEnrichWarnings(book);
    ok(book.contentWarnings.length === 1 && book.contentWarnings[0] === 'Violence (community)',
      '#135 first enrich merges accepted warning');
    ok(book._ccWarnEnriched === undefined, '#135 no _ccWarnEnriched flag on the book');
    await window.ccEnrichWarnings(book);
    ok(book.contentWarnings.length === 1, '#135 second enrich does not duplicate');
    rows = rows.concat([{ book_key: 'bk:b1', status: 'accepted', trigger_taxonomy: { label: 'Gore' } }]);
    await window.ccEnrichWarnings(book);
    ok(book.contentWarnings.length === 2 && book.contentWarnings[1] === 'Gore (community)',
      '#135 newly accepted warnings appear on re-enrich (staleness fixed)');
    // pre-existing suffixed entry from an old run must not duplicate either
    await window.ccEnrichWarnings(book);
    ok(book.contentWarnings.length === 2, '#135 still no duplicates after third run');
  }

  // ---------- #136: ccSheet token round-trip ----------
  {
    const window = buildDom();
    const realOpened = window.overlayOpened, realClosed = window.overlayClosed;
    let openedToken = null, closedToken = 'unset';
    window.overlayOpened = function (slot, closer) {
      const t = realOpened.call(window, slot, closer);
      if (slot === 'cc-sheet') openedToken = t;
      return t;
    };
    window.overlayClosed = function (token) {
      closedToken = token;
      return realClosed.call(window, token);
    };
    window.ccSheet('Test', '<p>hi</p>');
    ok(!!window.document.getElementById('ccSheet'), '#136 sheet opens in DOM');
    ok(typeof openedToken === 'string' && openedToken, '#136 overlayOpened issued a token');
    window.closeCcSheet();
    ok(!window.document.getElementById('ccSheet'), '#136 sheet removed from DOM');
    ok(closedToken === openedToken, '#136 closeCcSheet passes the stored token to overlayClosed');
    window.overlayOpened = realOpened; window.overlayClosed = realClosed;
  }

  // ---------- #137: nudgeEvaluate in-flight guard ----------
  {
    const window = buildDom();
    window.__sbStub = {}; // cloudClient resolves to a stub -> portraitCharCount bails to null
    window.document.body.insertAdjacentHTML('beforeend', '<div id="nudgeSlot"></div>');
    const book = { id: 'nb1', title: 'N', status: 'reading', readSessions: 5, dnaPromptCount: 0, dnaPromptAt: 0 };
    window.eval('library = ' + JSON.stringify([book]) + ';');
    const bookRef = window.eval('library[0]');
    await Promise.all([window.nudgeEvaluate(), window.nudgeEvaluate()]);
    ok(bookRef.dnaPromptCount === 1, '#137 overlapping nudgeEvaluate calls burn one prompt, not two');
    ok(!!window.document.querySelector('#nudgeSlot #nudgeSend'), '#137 nudge rendered with send button');
  }

  // ---------- #137: nudge send double-tap guard (chars flow) ----------
  {
    const window = buildDom();
    window.__sbStub = {}; // cloudClient resolves to a stub -> portraitCharCount bails to null
    window.document.body.insertAdjacentHTML('beforeend', '<div id="nudgeSlot"></div>');
    const book = { id: 'nb2', title: 'N', status: 'reading', readSessions: 5, dnaPromptCount: 0, dnaPromptAt: 0 };
    window.eval('library = ' + JSON.stringify([book]) + ';');
    let sends = 0;
    const realSuggest = window.CommunityCorpus.suggestCharacter;
    window.CommunityCorpus.suggestCharacter = async () => { sends++; await sleep(20); return { ok: true }; };
    await window.nudgeEvaluate();
    const nameInput = window.document.querySelector('#nudgeSlot #nudgeName');
    ok(!!nameInput, '#137 chars nudge rendered with name input');
    nameInput.value = 'Test Char';
    const btn = window.document.querySelector('#nudgeSlot #nudgeSend');
    btn.click(); btn.click(); // double-tap in the same tick
    await sleep(80);
    ok(sends === 1, '#137 double-tap sends exactly once');
    ok(btn.disabled === true, '#137 send button stays disabled after send');
    window.CommunityCorpus.suggestCharacter = realSuggest;
  }

  // ---------- #138: validate before rate-limit ----------
  {
    const window = buildDom();
    window.cloudClient = async () => null; // offline: submissions queue to the outbox
    const KEY = 'cozylibram.cc.ratelimit.v1';
    const count = () => { try { return JSON.parse(window.localStorage.getItem(KEY) || '{}').hourCount || 0; } catch (e) { return 0; } };
    window.localStorage.removeItem(KEY);
    await window.CommunityCorpus.proposeNewTrope('', 'desc', null);
    ok(count() === 0, '#138 empty trope name does not burn rate-limit budget');
    await window.CommunityCorpus.proposeNewTrope('   ', 'desc', null);
    ok(count() === 0, '#138 whitespace trope name does not burn rate-limit budget');
    await window.CommunityCorpus.suggestCharacter({ id: 'b1' }, {}, { quiet: true });
    ok(count() === 0, '#138 empty character name does not burn rate-limit budget');
    const r = await window.CommunityCorpus.proposeNewTrope('Forced Proximity', 'desc', null);
    ok(r && r.ok === true && count() === 1, '#138 valid submission still consumes one budget unit');
  }

  // ---------- #139: survey sheets register with the overlay manager ----------
  {
    const window = buildDom();
    const realOpened = window.overlayOpened, realClosed = window.overlayClosed;
    const opened = {}, closed = [];
    window.overlayOpened = function (slot, closer) {
      const t = realOpened.call(window, slot, closer);
      opened[slot] = t;
      return t;
    };
    window.overlayClosed = function (token) { closed.push(token); return realClosed.call(window, token); };
    window.openDnaSurvey({ id: 'sb1', title: 'T', status: 'read' });
    ok(typeof opened['dna-survey'] === 'string', '#139 openDnaSurvey registers with overlayOpened');
    window.document.querySelector('#svSkip').click();
    ok(closed.indexOf(opened['dna-survey']) !== -1, '#139 survey close passes its token to overlayClosed');
    window.openWarningPrefs();
    ok(typeof opened['warn-prefs'] === 'string', '#139 openWarningPrefs registers with overlayOpened');
    window.document.querySelector('#wpCancel').click();
    ok(closed.indexOf(opened['warn-prefs']) !== -1, '#139 warning-prefs close passes its token to overlayClosed');
    window.overlayOpened = realOpened; window.overlayClosed = realClosed;
  }

  // ---------- #140: concurrent friend fetches ----------
  {
    const window = buildDom();
    let inFlight = 0, maxInFlight = 0;
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const fakeQuery = (rows) => ({
      eq: (col, val) => ({
        maybeSingle: async () => {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(15); inFlight--;
          return { data: { user_id: val, first_name: 'F', last_name: 'L' }, error: null };
        },
        then: (res, rej) => {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          return delay(15).then(() => {
            inFlight--;
            res({ data: rows, error: null });
          }).then(res, rej);
        }
      })
    });
    const friendRows = [
      { book_id: 'x1', isbn: '', data: { id: 'x1', title: 'T1', authors: ['A'], status: 'read', myRating: 5 } },
      { book_id: 'x2', isbn: '', data: { id: 'x2', title: 'T2', authors: ['B'], status: 'read', myRating: 4 } }
    ];
    window.cloudClient = async () => ({ from: (table) => ({ select: () => fakeQuery(friendRows) }) });
    window.circleLists = async () => ({ friends: [{ id: 'f1', name: 'A' }, { id: 'f2', name: 'B' }] });
    window.eval('cloudUser = ({ id: "me" });');
    window.eval('library = [];');
    maxInFlight = 0;
    const d = await window.loadCovenStats();
    ok(d && d.people && d.people.length === 3, '#140 loadCovenStats returns me + 2 friends');
    ok(maxInFlight === 2, '#140 books+profile fetched concurrently per friend (max in-flight 2, was 1)');
    maxInFlight = 0;
    const recos = await window.loadRecos();
    ok(Array.isArray(recos) && recos.length === 2, '#140 loadRecos aggregates both friends\u2019 shelves');
    ok(maxInFlight === 2, '#140 friend shelves fetched concurrently (max in-flight 2, was 1)');
  }

  // ---------- #141: bounded work resolution ----------
  {
    const window = buildDom();
    window.document.body.insertAdjacentHTML('beforeend', '<div id="disc-reco"></div>');
    window.eval('library = ' + JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ id: 'rb' + i, title: 'T' + i, status: 'read' }))));
    let inFlight = 0, maxInFlight = 0;
    const callOrder = [];
    window.resolveWork = async (b) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      callOrder.push(b.id);
      await sleep(5);
      inFlight--;
      return 'w:' + b.id;
    };
    window.topLovedAuthors = () => ['Author A'];
    window.hcReady = () => true;
    window.fetchWorkEmbeddings = async () => { throw new Error('stop-after-resolve-phase'); };
    await window.refreshRecommendations(); // outer catch swallows the sentinel
    const ids = window.eval('library.map(b => b.id)');
    ok(callOrder.length === 20, '#141 all 20 books resolved');
    ok(maxInFlight > 1, '#141 resolution is concurrent (was strictly sequential)');
    ok(maxInFlight <= 8, '#141 concurrency bounded at 8 (max observed ' + maxInFlight + ')');
    ok(callOrder.join(',') === ids.join(','),
      '#141 resolution preserves book order');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
