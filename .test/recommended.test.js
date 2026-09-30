// v213: "Recommended for you" — embeddings-based recommendations in the
// Discovery tab. Covers the pure math (cosine similarity, rating-weighted
// taste profile, embed-text builder, pgvector parse), the loved-author /
// loved-trope helpers, owned-book exclusion, and dismissal persistence.
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
const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);

(async () => {
  // ---- cosineSim ----
  ok('cos: identical vectors', near(get('cosineSim([1,2,3],[1,2,3])'), 1));
  ok('cos: orthogonal', near(get('cosineSim([1,0],[0,1])'), 0));
  ok('cos: opposite', near(get('cosineSim([1,0],[-1,0])'), -1));
  ok('cos: scaled', near(get('cosineSim([2,0],[5,0])'), 1));
  ok('cos: length mismatch', get('cosineSim([1,2],[1])') === 0);
  ok('cos: empty', get('cosineSim([],[])') === 0);
  ok('cos: zero vector', get('cosineSim([0,0],[1,2])') === 0);
  ok('cos: non-numeric', get('cosineSim([1,"x"],[1,2])') === 0);
  ok('cos: NaN', get('cosineSim([1,NaN],[1,2])') === 0);
  ok('cos: not arrays', get('cosineSim(null,[1])') === 0);

  // ---- tasteProfileVector ----
  // [1,0] @5★ (w=1.0), [0,1] @1★ (w=0.2) → [1/1.2, 0.2/1.2]
  const pv = get('tasteProfileVector([{vector:[1,0],rating:5},{vector:[0,1],rating:1}])');
  ok('prof: weighted mean x', near(pv[0], 1 / 1.2));
  ok('prof: weighted mean y', near(pv[1], 0.2 / 1.2));
  // unrated read book counts neutrally: w = 3/5 = 0.6
  const pv2 = get('tasteProfileVector([{vector:[2,2],rating:0}])');
  ok('prof: unrated weight', near(pv2[0], 2) && near(pv2[1], 2));
  ok('prof: empty → null', get('tasteProfileVector([])') === null);
  ok('prof: null → null', get('tasteProfileVector(null)') === null);
  ok('prof: all invalid → null', get('tasteProfileVector([{vector:"nope",rating:5}])') === null);
  // mismatched dims dropped: [1,1] kept, [1,1,1] dropped → [1,1]
  const pv3 = get('tasteProfileVector([{vector:[1,1],rating:5},{vector:[1,1,1],rating:5}])');
  ok('prof: dim mismatch dropped', pv3.length === 2 && near(pv3[0], 1));

  // ---- buildEmbedText ----
  ok('embed-text: full format', get(
    'buildEmbedText({title:"Iron Flame",authors:["Rebecca Yarros"],' +
    'description:"Dragons at war.",tropes:["dragons"],genres:["fantasy"]})'
  ) === 'Iron Flame \u2014 Rebecca Yarros. Dragons at war.. Tropes: dragons. Genres: fantasy');
  ok('embed-text: title only', get('buildEmbedText({title:"X"})') === 'X');
  ok('embed-text: empty', get('buildEmbedText({})') === '');
  ok('embed-text: null', get('buildEmbedText(null)') === '');
  ok('embed-text: description capped', get('buildEmbedText({title:"T",description:"d".repeat(5000)}).length') <= 4000);
  ok('embed-text: categories alias', get(
    'buildEmbedText({title:"T",categories:["romance"]})'
  ) === 'T. Genres: romance');

  // ---- parseEmbedding ----
  ok('parse: array passthrough', JSON.stringify(get('parseEmbedding([0.1,0.2])')) === '[0.1,0.2]');
  ok('parse: pgvector string', JSON.stringify(get('parseEmbedding("[0.5,-1.5]")')) === '[0.5,-1.5]');
  ok('parse: garbage string → null', get('parseEmbedding("nope")') === null);
  ok('parse: null → null', get('parseEmbedding(null)') === null);
  ok('parse: non-numeric array → null', get('parseEmbedding([1,"x"])') === null);
  ok('parse: empty array → null', get('parseEmbedding([])') === null);

  // ---- topLovedAuthors ----
  runInWindow('library = [' +
    '{id:"a",title:"T1",authors:["Ann A"],status:"read",myRating:5},' +
    '{id:"b",title:"T2",authors:["Ann A","Bob B"],status:"read",myRating:4},' +
    '{id:"c",title:"T3",authors:["Bob B"],status:"read",myRating:2},' +   // low rating: ignored
    '{id:"d",title:"T4",authors:["Cat C"],status:"tbr",myRating:5},' +    // not read: ignored
    '{id:"e",title:"T5",authors:["Bob B"],status:"read",myRating:5},' +
    '{id:"f",title:"T6",authors:["Bob B"],status:"read",myRating:4}' +
    '];');
  ok('loved authors ranked', JSON.stringify(get('topLovedAuthors(6)')) === '["Bob B","Ann A"]');
  ok('loved authors limit', JSON.stringify(get('topLovedAuthors(1)')) === '["Bob B"]');
  runInWindow('library = [{id:"x",title:"T",authors:["Z"],status:"read",myRating:3}];');
  ok('loved authors: none qualify', JSON.stringify(get('topLovedAuthors(6)')) === '[]');

  // ---- recoLovedTropeIds (display names resolve through the taxonomy) ----
  runInWindow('library = [' +
    '{id:"a",title:"T1",authors:["Ann A"],status:"read",myRating:5,tropes:["Dragons"],tropesAuto:[]},' +
    '{id:"b",title:"T2",authors:["Bob B"],status:"read",myRating:2,tropes:["Slow Burn"],tropesAuto:[]}' + // low: ignored
    '];');
  const loved = get('recoLovedTropeIds()');
  ok('loved tropes: resolved id', loved.indexOf('dragons') !== -1);
  ok('loved tropes: low-rated excluded', loved.indexOf('slow-burn') === -1);

  // ---- recoSharedTropes ----
  ok('shared: name match', JSON.stringify(
    get('recoSharedTropes("A tale of enemies to lovers and dragons", ["enemies-to-lovers", "dragons"])')
  ) === '["Enemies to Lovers","Dragons"]');
  ok('shared: alias match', get(
    'recoSharedTropes("a why choose romance", ["why-choose"]).length'
  ) === 1);
  ok('shared: no match', get('recoSharedTropes("cozy baking mystery", ["dragons"]).length') === 0);
  ok('shared: capped at 3', get(
    'recoSharedTropes("dragons magic academy deadly trials forced proximity", ' +
    '["dragons","magic-academy","deadly-trials","forced-proximity"]).length'
  ) === 3);
  ok('shared: empty loved', get('recoSharedTropes("dragons", []).length') === 0);

  // ---- releaseInLibrary: owned-book exclusion for candidates ----
  runInWindow('library = [' +
    '{id:"a",isbn:"9781234567890",title:"Owned Title",authors:["Ann A"],status:"read",myRating:5},' +
    '{id:"b",isbn:"",title:"No Isbn Book",authors:["Bob B"],status:"tbr",myRating:0}' +
    '];');
  ok('owned: ISBN match excluded', get('releaseInLibrary({isbns:["9781234567890"],title:"Other",authors:["X"]})'));
  ok('owned: title+author match excluded',
    get('releaseInLibrary({isbns:[],title:"no isbn book",authors:["bob b"]})'));
  ok('owned: fresh book passes',
    !get('releaseInLibrary({isbns:["9780000000000"],title:"Brand New",authors:["New Author"]})'));

  // ---- recoDismiss: dismissal round-trip (IDB unavailable in tests → localStorage) ----
  runInWindow('localStorage.removeItem("spicyshelves.reco_dismissed");');
  runInWindow('window.__p = (async () => { await recoDismiss("hc:42"); return (await recoDismissedSet()).has("hc:42"); })();');
  ok('dismiss: round-trip', await window.__p === true);
  runInWindow('window.__p2 = (async () => { await recoDismiss("hc:43"); return (await recoDismissedSet()).size; })();');
  ok('dismiss: accumulates', await window.__p2 === 2);

  console.log('\\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
