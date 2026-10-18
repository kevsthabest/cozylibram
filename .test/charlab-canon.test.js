// Character Lab unified canonical view regression tests — issue #356.
// The unified view (charLabCanonDetail) groups a canonical character's
// linked instances with unlink controls, but it was unreachable: no code
// path ever assigned charLabCanonicalId, and no template emitted the
// #ch-canon-detail container it paints into. These tests drive the real
// flow: a linked row in the Characters view -> Unified view button ->
// Review view renders the grouped instances.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const { loadApp, APP_DIR } = require('./harness');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in charlab-canon tests'); };
loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const q = (s) => window.document.querySelector(s);

(async () => {
  // Observatory shell mount point.
  const body = window.document.createElement('div');
  body.id = 'ob-body';
  window.document.body.appendChild(body);

  // Store fakes: the defect is in js/162's wiring, so the data layer is
  // stubbed at the CharacterStore surface js/162 consumes.
  run(`(function(){
    const chain = { data: [] };
    const builder = {
      select() { return builder; }, in() { return builder; },
      eq() { return builder; }, not() { return builder; },
      then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); }
    };
    CharacterStore._sb = async () => ({ from: () => builder });
    CharacterStore.listWorks = async () => ([
      { workId: 'w1', title: 'Work One', count: 2 },
      { workId: 'w2', title: 'Work Two', count: 1 }
    ]);
    CharacterStore.listForWork = async () => ([
      { id: 'bc1', name: 'Willa Wynn', role: 'protagonist', description: 'lead',
        confidence: null, status: 'confirmed', characterId: 'canon-1',
        suggestedCharacterId: null, duplicateOf: null, mergeSnapshot: null,
        relationships: [] },
      { id: 'bc2', name: 'Thea Thorn', role: 'antagonist', description: '',
        confidence: null, status: 'confirmed', characterId: null,
        suggestedCharacterId: null, duplicateOf: null, mergeSnapshot: null,
        relationships: [] }
    ]);
    CharacterStore.getCanonicalDetail = async (id) => id !== 'canon-1' ? null : ({
      id: 'canon-1', name: 'Willa Wynn', description: 'The unified one',
      aliases: [], source: 'manual',
      instances: [
        { id: 'bc1', workId: 'w1', workTitle: 'Work One', name: 'Willa Wynn',
          role: 'protagonist', description: '', relationships: [{ to: 'Thea Thorn', type: 'friend' }] },
        { id: 'bc9', workId: 'w2', workTitle: 'Work Two', name: 'Willa',
          role: 'supporting', description: '', relationships: [] }
      ]
    });
    charLabView = 'characters';
    charLabWorkId = 'w1';
    charLabSelectedId = 'bc1';
  })();`);
  await run(`renderCharacterLab()`);
  await sleep(50);

  // 1. The linked row's detail card offers the way into the unified view.
  const viewBtn = q('[data-chcanonview="canon-1"]');
  ok('linked row detail offers a Unified view entry point', !!viewBtn);

  // 2. Activating it renders the unified view: container emitted, grouped
  //    instances painted, unlink controls present.
  if (viewBtn) viewBtn.click();
  await sleep(150);
  const detail = q('#ch-canon-detail');
  ok('Review view emits #ch-canon-detail', !!detail);
  ok('unified view names the canonical character', !!detail && detail.innerHTML.includes('Willa Wynn'));
  ok('unified view groups both linked instances', !!detail &&
    detail.innerHTML.includes('Appears in (2)') &&
    detail.innerHTML.includes('Work One') && detail.innerHTML.includes('Work Two'));
  ok('unified view carries per-instance unlink controls', !!detail &&
    detail.querySelectorAll('[data-chunlink]').length === 2);

  console.log('charlab-canon: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
