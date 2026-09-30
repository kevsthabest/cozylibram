// v212: high-confidence AI tropes (the auto-publish tier) auto-add to the
// book's own trope list. Candidates never auto-add; ×-removing an AI-added
// trope tombstones it so the merge never resurrects it.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const get = (js) => { runInWindow('window.__v = (' + js + ');'); return window.__v; };

(async () => {
  // stub persistence: count saves without touching storage
  runInWindow('window.__saves = 0; saveLibrary = function() { window.__saves++; };');

  // isAutoConfirmed: only the v208 auto-publish tier qualifies
  ok('auto: confirmed ai with flag', get('isAutoConfirmed({status:"confirmed",source_type:"ai",evidence:{auto_confirmed:true}})'));
  ok('auto: string evidence works', get('isAutoConfirmed({status:"confirmed",source_type:"ai",evidence:JSON.stringify({auto_confirmed:true})})'));
  ok('not auto: candidate', !get('isAutoConfirmed({status:"candidate",source_type:"ai",evidence:{auto_confirmed:true}})'));
  ok('not auto: community confirmed', !get('isAutoConfirmed({status:"confirmed",source_type:"community",evidence:{}})'));
  ok('not auto: confirmed ai without flag (admin-confirmed candidate)', !get('isAutoConfirmed({status:"confirmed",source_type:"ai",evidence:{}})'));
  ok('not auto: null row', !get('isAutoConfirmed(null)'));

  // resolveClaims threads the flag through
  runInWindow(`window.__rc = resolveClaims([
    {trope_id:'dragons',status:'confirmed',confidence:0.95,source_type:'ai',evidence:{auto_confirmed:true}},
    {trope_id:'magic-academy',status:'candidate',confidence:0.7,source_type:'ai',evidence:{}},
  ]);`);
  const rc = window.__rc;
  ok('resolveClaims keeps both', rc.length === 2);
  ok('resolveClaims flags auto', rc.find(t => t.id === 'dragons').auto === true);
  ok('resolveClaims leaves candidate unflagged', rc.find(t => t.id === 'magic-academy').auto === false);

  // auto-add: adds auto claims, skips candidates, lowercases, badges
  runInWindow(`window.__b = { tropes: ['mafia romance'], _mtime: 100 };
    window.__added = autoAddConfirmedTropes(window.__b, window.__rc);`);
  const b = window.__b;
  ok('auto-add returns true when changed', window.__added === true);
  ok('auto-add appends Dragons', b.tropes.includes('dragons'));
  ok('auto-add skips the candidate', !b.tropes.includes('magic academy'));
  ok('auto-add keeps her tropes', b.tropes.includes('mafia romance'));
  ok('auto-add sets badge list', (b.tropesAI || []).includes('dragons'));
  ok('auto-add bumps _mtime and saves', b._mtime > 100 && window.__saves > 0);

  // idempotent: second run changes nothing
  runInWindow('window.__saves = 0; window.__added2 = autoAddConfirmedTropes(window.__b, window.__rc);');
  ok('auto-add is idempotent', window.__added2 === false && window.__saves === 0);

  // dedupe is case-insensitive: hand-added "Dragons" blocks the AI add
  runInWindow(`window.__c = { tropes: ['Dragons'], _mtime: 50 };
    autoAddConfirmedTropes(window.__c, window.__rc);`);
  ok('auto-add dedupes case-insensitively', window.__c.tropes.filter(t => t.toLowerCase() === 'dragons').length === 1);
  ok('badge still set for existing match', (window.__c.tropesAI || []).includes('dragons'));

  // dismissed ids are never re-added
  runInWindow(`window.__d = { tropes: [], tropesAIDismissed: ['dragons'], _mtime: 50 };
    window.__addedD = autoAddConfirmedTropes(window.__d, window.__rc);`);
  ok('dismissed trope not re-added', !window.__d.tropes.includes('dragons'));
  ok('dismissed trope not badged', !(window.__d.tropesAI || []).includes('dragons'));

  // dismissAutoTrope tombstones the id
  runInWindow('window.__e = { tropesAI: ["dragons"] }; dismissAutoTrope(window.__e, "dragons"); dismissAutoTrope(window.__e, "dragons");');
  ok('dismiss tombstones the id', (window.__e.tropesAIDismissed || []).includes('dragons'));
  ok('dismiss does not duplicate', window.__e.tropesAIDismissed.length === 1);

  // badge reconciliation: claim no longer auto -> badge drops, text stays
  runInWindow(`window.__f = { tropes: ['dragons', 'mafia romance'], tropesAI: ['dragons'] };
    window.__rc2 = resolveClaims([{trope_id:'dragons',status:'rejected',confidence:0.95,source_type:'ai',evidence:{auto_confirmed:true}}]);
    autoAddConfirmedTropes(window.__f, window.__rc2);`);
  ok('rejected claim drops the badge', !(window.__f.tropesAI || []).includes('dragons'));
  ok('rejected claim leaves her text alone', window.__f.tropes.includes('dragons'));

  // migrateBook normalizes the new arrays
  runInWindow('window.__m = {}; migrateBook(window.__m);');
  ok('migrateBook adds tropesAI', Array.isArray(window.__m.tropesAI));
  ok('migrateBook adds tropesAIDismissed', Array.isArray(window.__m.tropesAIDismissed));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
