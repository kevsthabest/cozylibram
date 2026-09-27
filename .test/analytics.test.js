// Analytics tests (v118): the track() pipeline, privacy allowlist, offline
// queue/batch/retry behavior, onboarding diff helper, and the SQL security
// model. The spec's hard rule: analytics must never break the app and must
// never carry book content.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const runInWindow = (js) => window.eval(js);
const qkey = (uid) => 'spicyshelves.analytics.queue.' + uid;
const qlen = (uid) => runInWindow(`(JSON.parse(localStorage.getItem('${qkey(uid)}') || '[]')).length`);
const qprops = (uid, i) => runInWindow(`JSON.parse(localStorage.getItem('${qkey(uid)}') || '[]')[${i}].properties`);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

(async () => {
  // Fake Supabase: captures inserts, can fail on demand.
  window.__aFake = {
    inserted: [],
    failNext: false,
    from(table) {
      const self = this;
      return {
        insert: async (rows) => {
          if (self.failNext) { self.failNext = false; return { error: new Error('boom') }; }
          self.inserted.push({ table: table, rows: rows });
          return { error: null };
        },
      };
    },
  };
  runInWindow(`cloudClient = async () => window.__aFake;`);
  runInWindow(`cloudUser = { id: 'u1', email: 't@t.t' };`);
  runInWindow(`localStorage.clear(); analyticsQueue = null; analyticsCooldownUntil = 0;`);

  // 1. Unknown events are dropped silently.
  ok('unknown event returns false', runInWindow(`track('definitely_not_real')`) === false);
  ok('unknown event queues nothing', qlen('u1') === 0);

  // 2. Property allowlist: declared keys pass, everything else is stripped.
  runInWindow(`track('book_added', { source: 'search', title: 'Secret Title', author: 'Anon', evil: 1 })`);
  const p1 = qprops('u1', 0);
  ok('allowed prop kept', p1 && p1.source === 'search');
  ok('book content props stripped', p1 && !('title' in p1) && !('author' in p1) && !('evil' in p1));

  // 3. Enum values are validated — unknown values are dropped, event kept.
  runInWindow(`track('book_added', { source: 'hacker-source' })`);
  const p2 = qprops('u1', 1);
  ok('unknown enum value dropped from props', p2 && !('source' in p2));
  ok('event still recorded without the bad prop', qlen('u1') === 2);

  // 4. book_count is numeric and clamped.
  runInWindow(`track('import_completed', { source: 'goodreads', book_count: '12' })`);
  const p3 = qprops('u1', 2);
  ok('book_count coerced to number', p3 && p3.book_count === 12);

  // 5. Signed-out users emit nothing (no anonymous attribution).
  runInWindow(`cloudUser = null;`);
  ok('track without user returns false', runInWindow(`track('book_opened')`) === false);
  ok('nothing queued while signed out', qlen('u1') === 3);
  runInWindow(`cloudUser = { id: 'u1', email: 't@t.t' };`);

  // 6. Opt-out kills tracking and clears the queue.
  runInWindow(`setAnalyticsEnabled(false)`);
  ok('track while opted out returns false', runInWindow(`track('book_opened')`) === false);
  ok('opt-out clears persisted queue', qlen('u1') === 0);
  runInWindow(`setAnalyticsEnabled(true)`);

  // 7. Every event carries the app version.
  runInWindow(`track('book_opened')`);
  const ver = runInWindow(`JSON.parse(localStorage.getItem('${qkey('u1')}') || '[]')[0].app_version`);
  ok('event stamped with APP_VERSION', ver === runInWindow(`APP_VERSION`) && typeof ver === 'string');

  // 8. Dedupe: same key inside the window is dropped.
  runInWindow(`localStorage.clear(); analyticsQueue = null;`);
  const d1 = runInWindow(`track('book_opened', null, { dedupeKey: 'k1' })`);
  const d2 = runInWindow(`track('book_opened', null, { dedupeKey: 'k1' })`);
  ok('first deduped call queues', d1 === true);
  ok('second deduped call dropped', d2 === false);
  ok('dedupe left exactly one event', qlen('u1') === 1);

  // 9. trackOnce fires at most once ever.
  runInWindow(`localStorage.clear(); analyticsQueue = null;`);
  const o1 = runInWindow(`trackOnce('f1', 'first_book_added')`);
  const o2 = runInWindow(`trackOnce('f1', 'first_book_added')`);
  ok('trackOnce fires the first time', o1 === true);
  ok('trackOnce suppressed the second time', o2 === false);
  ok('trackOnce left exactly one event', qlen('u1') === 1);

  // 10. trackBookSaveDiff — the detail-modal Save analytics.
  runInWindow(`localStorage.clear(); analyticsQueue = null;`);
  const names = () => runInWindow(`(JSON.parse(localStorage.getItem('${qkey('u1')}') || '[]')).map(e => e.event_name).join(',')`);
  const propsOf = (n) => runInWindow(`(JSON.parse(localStorage.getItem('${qkey('u1')}') || '[]')).find(e => e.event_name === '${n}').properties`);
  runInWindow(`trackBookSaveDiff({ status: 'tbr', myRating: 0, ratings: {} },
    { status: 'read', myRating: 4, ratings: { spice: 3 }, title: 'T', notes: '', tropes: [], pageCount: 300 })`);
  ok('status change tracked', names().includes('book_status_changed'));
  ok('status from/to carried', JSON.stringify(propsOf('book_status_changed')) === JSON.stringify({ from: 'tbr', to: 'read' }));
  ok('completion tracked', names().includes('book_completed'));
  ok('rating tracked', names().includes('book_rated'));
  ok('first rating tracked once', names().includes('first_book_rated'));
  ok('axis usage tracked', propsOf('rating_axis_used').axis === 'spice');
  ok('edited fields tracked', names().includes('book_edited'));
  runInWindow(`localStorage.clear(); analyticsQueue = null;`);
  runInWindow(`trackBookSaveDiff({ status: 'read', myRating: 4, ratings: { spice: 3 }, title: 'T', notes: '', tropes: [], pageCount: 300 },
    { status: 'read', myRating: 4, ratings: { spice: 3 }, title: 'T', notes: '', tropes: [], pageCount: 300 })`);
  ok('no diff means no events', qlen('u1') === 0);
  runInWindow(`trackBookSaveDiff({ status: 'reading' }, { status: 'dnf' })`);
  ok('dnf tracked', names().includes('book_dnf'));

  // 11. Batching: 55 events upload as 50 + 5.
  runInWindow(`localStorage.clear(); analyticsQueue = null; window.__aFake.inserted = [];`);
  runInWindow(`for (let i = 0; i < 55; i++) track('book_opened');`);
  await new Promise(r => setTimeout(r, 50)); // let the auto-flush at 50 land
  await runInWindow(`flushAnalytics()`);
  const total = window.__aFake.inserted.reduce((n, c) => n + c.rows.length, 0);
  const biggest = Math.max(...window.__aFake.inserted.map(c => c.rows.length));
  ok('all 55 events uploaded across batches', total === 55);
  ok('no batch exceeds the cap', biggest <= 50);
  ok('queue empty after successful flush', qlen('u1') === 0);
  ok('inserts went to analytics_events', window.__aFake.inserted.every(c => c.table === 'analytics_events'));

  // 12. Failed upload: batch requeued, cooldown engaged, retry later works.
  runInWindow(`localStorage.clear(); analyticsQueue = null; window.__aFake.inserted = []; window.__aFake.failNext = true;`);
  runInWindow(`track('book_opened'); track('book_opened');`);
  await runInWindow(`flushAnalytics()`);
  ok('failed batch requeued, not lost', qlen('u1') === 2);
  ok('cooldown engaged after failure', runInWindow(`analyticsCooldownUntil`) > Date.now());
  ok('nothing uploaded on failure', window.__aFake.inserted.length === 0);
  await runInWindow(`flushAnalytics()`); // still cooling down — stays queued
  ok('cooldown blocks immediate retry', qlen('u1') === 2 && window.__aFake.inserted.length === 0);
  runInWindow(`analyticsCooldownUntil = 0;`);
  await runInWindow(`flushAnalytics()`);
  ok('retry after cooldown uploads', qlen('u1') === 0 && window.__aFake.inserted.length === 1);

  // 13. Offline: navigator offline keeps events queued.
  runInWindow(`localStorage.clear(); analyticsQueue = null; window.__aFake.inserted = [];`);
  Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
  runInWindow(`track('book_opened');`);
  await runInWindow(`flushAnalytics()`);
  ok('offline flush keeps events queued', qlen('u1') === 1 && window.__aFake.inserted.length === 0);
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });

  // 14. analyticsSessionBoot: session + onboarding funnel, no double-fire.
  runInWindow(`localStorage.clear(); analyticsQueue = null;`);
  runInWindow(`library = [{ id: 'b1', title: 'Owned', myRating: 5 }];`); // existing user: flags seed, no "firsts"
  runInWindow(`analyticsSessionBoot();`);
  const bootNames = () => runInWindow(`(JSON.parse(localStorage.getItem('${qkey('u1')}') || '[]')).map(e => e.event_name).join(',')`);
  ok('session_started fires on boot', bootNames().includes('session_started'));
  ok('library_opened fires on boot', bootNames().includes('library_opened'));
  ok('existing library does not fake first_book_added', !bootNames().includes('first_book_added'));
  runInWindow(`analyticsSessionBoot();`);
  ok('library_opened does not double-fire', (bootNames().match(/library_opened/g) || []).length === 1);
  ok('session_started fires per boot', (bootNames().match(/session_started/g) || []).length === 2);

  // 15. EVENT_DEFS structural privacy: no prop key can ever carry book content.
  const defs = runInWindow(`EVENT_DEFS`);
  const forbidden = ['title', 'author', 'authors', 'isbn', 'rating', 'myRating', 'notes', 'shelf', 'cover'];
  const leaked = Object.entries(defs).filter(([n, d]) => (d.p || []).some(k => forbidden.includes(k)));
  ok('no event declares a book-content property', leaked.length === 0);
  ok('event count stays in the 20–40 range', Object.keys(defs).length >= 20 && Object.keys(defs).length <= 40);

  // 16. SQL security model.
  const sql = fs.readFileSync('/home/hatch/workspace/booktok/supabase/analytics.sql', 'utf8');
  ok('analytics_events table created', /create table if not exists analytics_events/.test(sql));
  ok('app_admins registry created', /create table if not exists app_admins/.test(sql));
  ok('is_admin() is security definer', /security definer/.test(sql));
  ok('users can insert only their own events', /for insert[\s\S]*?with check \(auth\.uid\(\) = user_id\)/.test(sql));
  ok('admins can select analytics', /on analytics_events for select[\s\S]*?using \(is_admin\(\)\)/.test(sql));
  ok('no user-level select on analytics_events', !/on analytics_events for select[\s\S]*?auth\.uid\(\)/.test(sql));
  ok('no update policy on analytics_events', !/on analytics_events for update/.test(sql));
  ok('no delete policy on analytics_events', !/on analytics_events for delete/.test(sql));
  ok('admin registry readable only by admins', /on app_admins for select[\s\S]*?using \(is_admin\(\)\)/.test(sql));
  ok('created_at indexed for dashboard range queries', /analytics_events_created/.test(sql));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
