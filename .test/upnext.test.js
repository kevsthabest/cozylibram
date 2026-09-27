// Up Next queue tests (v74).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in upnext tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const queuedIds = () => JSON.parse(window.localStorage.getItem('spicyshelves.upnext.v1') || '[]');
const mk = (id, status) => ({
  id, isbn: '', title: 'Book ' + id, authors: ['Author ' + id], cover: '',
  description: '', pageCount: 300, publishedDate: '', categories: ['romance'],
  publicRating: null, ratingsCount: 0, status: status || 'tbr',
  ratings: { spice: 3 }, axes: ['spice'], myRating: 0, tropes: [],
  progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
});

runInWindow(`(function(){
  localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0; upNext = [];
  library.push(${JSON.stringify(mk('a'))}, ${JSON.stringify(mk('b'))}, ${JSON.stringify(mk('c'))});
})();`);

// 1. queue ops keep order, ignore duplicates
window.upNextAdd('a'); window.upNextAdd('b'); window.upNextAdd('c'); window.upNextAdd('a');
ok('adds preserve order, duplicates ignored', JSON.stringify(queuedIds()) === '["a","b","c"]');
window.upNextMove('c', -1);
ok('move up swaps', JSON.stringify(queuedIds()) === '["a","c","b"]');
window.upNextMove('a', -1);
ok('move up at top is a no-op', JSON.stringify(queuedIds()) === '["a","c","b"]');
window.upNextMove('a', 1);
ok('move down swaps', JSON.stringify(queuedIds()) === '["c","a","b"]');
window.upNextRemove('a');
ok('remove drops the id', JSON.stringify(queuedIds()) === '["c","b"]');
ok('upNextBooks resolves in queue order',
  window.upNextBooks().map(b => b.id).join(',') === 'c,b');

// 2. stale ids are filtered on load
window.localStorage.setItem('spicyshelves.upnext.v1', JSON.stringify(['c', 'ghost']));
runInWindow('upNext = loadUpNext();');
ok('loadUpNext drops ids of deleted books', JSON.stringify(queuedIds()) === '["c"]');

// 3. library shelf shows the queue with position badges
window.upNextAdd('b');
runInWindow('go("library");');
const badges = qa('#view .un-num').map(el => el.textContent);
ok('shelf shows numbered queue badges', badges.join(',') === '1,2');
ok('shelf has a Manage button', !!q('#un-manage'));

// 4. manage view reorders and removes
q('#un-manage').click();
ok('manage view lists queue rows', qa('#view .un-row').length === 2);
qa('#view .un-row [data-mv="1"]')[0].click(); // move #1 down
ok('manage move-down reorders', queuedIds().join(',') === 'b,c');
qa('#view .un-row [data-rm]')[1].click(); // remove second
ok('manage remove drops the book', queuedIds().join(',') === 'b');

// 5. detail modal toggle
runInWindow(`openDetail('a');`);
ok('modal offers to add to Up Next', q('#m-upnext') && q('#m-upnext').textContent.includes('Add to Up Next'));
q('#m-upnext').click();
ok('modal toggle queues the book', queuedIds().includes('a'));
ok('modal toggle flips label', q('#m-upnext').textContent.includes('In your Up Next queue'));

// 6. saving as reading dequeues the book
qa('#m-x'); // sanity: modal open
qa('#modal-root #f-status button').forEach(x => { if (x.dataset.s === 'reading') x.click(); });
q('#m-save').click();
ok('marking a book reading removes it from Up Next', !queuedIds().includes('a'));

// 7. removeBook cleans the queue
window.upNextAdd('c');
ok('queued before delete', queuedIds().includes('c'));
runInWindow(`removeBook('c');`);
ok('deleting a book drops it from the queue', !queuedIds().includes('c'));

// 8. roulette "Up Next only"
runInWindow(`(function(){
  pickState.genres = []; pickState.trope = ''; pickState.minIntensity = 0;
  pickState.upNextOnly = true;
})();`);
const cands = window.pickCandidates();
ok('roulette up-next-only filters to queued TBR books',
  cands.length === 1 && cands[0].id === 'b');
runInWindow('pickState.upNextOnly = false;');
// 'a' is now reading and 'c' was deleted, so the full TBR pool is just 'b'
ok('roulette filter off restores full TBR pool', window.pickCandidates().length === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
