// Regression pin for issue #411: syncCloudProfile must carry the same
// capture-and-recheck ownership discipline PR #410 added to the library
// and settings pull legs after #327. The profile leg captured cloudUser
// once and applied whatever its fetches returned after multiple awaits —
// and because profileKey() resolves against the LIVE cloudUser, an
// account switch mid-flight wrote account A's adopted profile into
// account B's profile slot (and the push leg could push under B's id a
// profile that was loaded for A).
//
// The interleaving is reproduced the same way as sync-pull-ownership:
// the profiles fetch is gated, the sync starts under A, the test flips
// cloudUser to B, then releases A's response.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sync-profile-ownership tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

(async () => {
  let releaseFetch;
  const gate = new Promise(r => releaseFetch = r);
  const aRow = {
    first_name: 'Alice', last_name: 'Aye', avatar_id: '', avatar_path: '',
    updated_at: new Date(Date.now() + 60000).toISOString(),
    gender: 'f', bio: 'A bio', fav_genres: [], handle: '', findable: false,
  };
  const upserts = [];
  window.__sbStub = {
    from: (table) => {
      if (table !== 'profiles') throw new Error('unexpected table: ' + table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => gate.then(() => ({ data: aRow, error: null })),
          }),
        }),
        upsert: async (row) => { upserts.push(row); return { error: null }; },
      };
    },
  };

  // B's own profile already lives in B's slot.
  runInWindow(`cloudUser = { id: 'uB' };
    localStorage.setItem('spicyshelves.profile.uB', JSON.stringify({
      firstName: 'Bea', lastName: 'Bee', gender: '', avatar: { type: 'letter' },
      avatarCloudPath: '', updatedAt: 1000, bio: '', favGenres: [], handle: '', findable: false }));`);

  // The sync starts under A; A's fetch is in flight when the switch lands.
  runInWindow(`cloudUser = { id: 'uA' };`);
  const syncPromise = probe(`syncCloudProfile()`);
  await tick(30);
  runInWindow(`cloudUser = { id: 'uB' };`);
  releaseFetch();
  await syncPromise;
  await tick(30);

  const bProfile = JSON.parse(window.localStorage.getItem('spicyshelves.profile.uB'));
  ok('#411 A\'s adopted profile is not written into B\'s profile slot',
    bProfile.firstName === 'Bea' && bProfile.lastName === 'Bee');
  ok('#411 nothing is pushed under B from A\'s in-flight sync', upserts.length === 0);

  // Control: with no switch, the same sync adopts A's row into A's slot.
  runInWindow(`cloudUser = { id: 'uA' };`);
  await probe(`syncCloudProfile()`);
  await tick(30);
  const aProfile = JSON.parse(window.localStorage.getItem('spicyshelves.profile.uA') || 'null');
  ok('#411 control: an uncontested sync still adopts the cloud profile',
    !!aProfile && aProfile.firstName === 'Alice' && aProfile.lastName === 'Aye');

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
