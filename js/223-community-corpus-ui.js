/* ---- Community corpus UI v1: suggestion flows on book modal + character wiki.
   - "Suggest a trope" picker (89-catalog IDs only) on the Tropes tab
   - "Propose a new trope idea" (curation queue, never auto-added)
   - "Suggest a character" + merge proposals (evidence required) on Characters tab
   - "Suggest a warning" on content-warnings details (controlled taxonomy)
   - Accepted community trigger warnings merged into the Start Reading
     trigger-check data source (PR #87 flywheel)
   - One-tap correction (vote buttons) already exists — untouched.

   Wiring: MutationObserver injects affordances idempotently so the big
   modal render functions stay untouched.
*/
(function () {
'use strict';

var CC = null; // window.CommunityCorpus, resolved lazily
function cc() {
  if (!CC && typeof window.CommunityCorpus !== 'undefined') CC = window.CommunityCorpus;
  return CC;
}
function escHtml(s) {
  try { return (typeof esc === 'function') ? esc(s) : String(s); }
  catch (e) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
}

/* ---------- generic bottom sheet ---------- */
function ccSheet(title, bodyHTML, onMount) {
  closeCcSheet();
  var scrim = document.createElement('div');
  scrim.className = 'sv-scrim'; scrim.id = 'ccScrim';
  var sheet = document.createElement('div');
  sheet.className = 'sv-sheet'; sheet.id = 'ccSheet';
  sheet.innerHTML = '<div class="tc-inner"><p class="tc-title">' + escHtml(title) + '</p>' + bodyHTML + '</div>';
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  requestAnimationFrame(function () { sheet.classList.add('open'); });
  var token = (typeof overlayOpened === 'function') ? overlayOpened('cc-sheet', closeCcSheet) : null;
  scrim.addEventListener('click', closeCcSheet);
  if (typeof onMount === 'function') onMount(sheet, closeCcSheet);
  return closeCcSheet;
}
function closeCcSheet() {
  ['ccScrim', 'ccSheet'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
  if (typeof overlayClosed === 'function') { try { overlayClosed(); } catch (e) {} }
}

/* The book currently open in the detail modal (stashed by observer). */
var ccBook = null;

/* ---------- trope picker (89 catalog IDs only) ---------- */
function openTropePicker(book) {
  var mod = cc();
  if (!mod) { toast('Community module not loaded'); return; }
  var list = [];
  try {
    if (typeof TropeTaxonomy !== 'undefined' && TropeTaxonomy.list) list = TropeTaxonomy.list();
  } catch (e) {}
  if (!list.length) { toast('Trope catalog not loaded'); return; }
  var items = list.map(function (t) { return { id: t.id, name: t.name || t.id }; });
  ccSheet('Suggest a trope', 
    '<p class="note">Pick from the curated catalog — suggestions go to the curator for review.</p>' +
    '<input id="ccTropeSearch" class="text-input" placeholder="Search tropes…" style="width:100%;margin:8px 0">' +
    '<div id="ccTropeList" class="cc-picklist" style="max-height:40vh;overflow:auto"></div>' +
    '<p style="margin-top:10px"><button class="taplink" id="ccNewTropeIdea">Have a trope idea that isn\'t listed? Propose it →</button></p>',
    function (sheet, close) {
      var render = function (q) {
        q = String(q || '').toLowerCase();
        var shown = items.filter(function (t) {
          return !q || t.name.toLowerCase().indexOf(q) >= 0 || t.id.indexOf(q) >= 0;
        }).slice(0, 60);
        sheet.querySelector('#ccTropeList').innerHTML = shown.map(function (t) {
          return '<button class="chip" data-ctid="' + escHtml(t.id) + '">' + escHtml(t.name) + '</button>';
        }).join('') || '<p class="note">No matches.</p>';
        sheet.querySelectorAll('[data-ctid]').forEach(function (b) {
          b.addEventListener('click', function () {
            mod.suggestTrope(book, b.getAttribute('data-ctid')).then(function (r) {
              if (r && r.ok) close();
            });
          });
        });
      };
      sheet.querySelector('#ccTropeSearch').addEventListener('input', function (e) { render(e.target.value); });
      sheet.querySelector('#ccNewTropeIdea').addEventListener('click', function () { close(); openNewTropeIdea(book); });
      render('');
      var inp = sheet.querySelector('#ccTropeSearch');
      if (inp) inp.focus();
    });
}

function openNewTropeIdea(book) {
  var mod = cc();
  if (!mod) return;
  ccSheet('Propose a trope idea',
    '<p class="note">Ideas outside the catalog go to the curator — they\'re never added automatically.</p>' +
    '<input id="ccNtName" class="text-input" placeholder="Trope name" style="width:100%;margin:6px 0">' +
    '<textarea id="ccNtDesc" class="text-input" rows="3" placeholder="What happens in this trope? (a sentence or two)" style="width:100%"></textarea>' +
    '<p style="margin-top:10px"><button class="btn" id="ccNtSend">Send idea</button> ' +
    '<button class="btn ghost" id="ccNtCancel">Cancel</button></p>',
    function (sheet, close) {
      sheet.querySelector('#ccNtCancel').addEventListener('click', close);
      sheet.querySelector('#ccNtSend').addEventListener('click', function () {
        var name = sheet.querySelector('#ccNtName').value;
        var desc = sheet.querySelector('#ccNtDesc').value;
        mod.proposeNewTrope(name, desc, book).then(function (r) { if (r && r.ok) close(); });
      });
    });
}

/* ---------- character suggestion ---------- */
function openCharacterSuggest(book) {
  var mod = cc();
  if (!mod) return;
  ccSheet('Suggest a character',
    '<p class="note">Who\'s missing from this book\'s cast?</p>' +
    '<input id="ccChName" class="text-input" placeholder="Character name" style="width:100%;margin:6px 0">' +
    '<select id="ccChRole" class="text-input" style="width:100%;margin:6px 0">' +
    '<option value="">Role (optional)</option>' +
    '<option value="protagonist">Protagonist</option>' +
    '<option value="antagonist">Antagonist</option>' +
    '<option value="supporting">Supporting</option>' +
    '<option value="minor">Minor</option></select>' +
    '<textarea id="ccChDesc" class="text-input" rows="3" placeholder="Who are they? (a sentence or two)" style="width:100%"></textarea>' +
    '<p style="margin-top:10px"><button class="btn" id="ccChSend">Send suggestion</button> ' +
    '<button class="btn ghost" id="ccChCancel">Cancel</button></p>',
    function (sheet, close) {
      sheet.querySelector('#ccChCancel').addEventListener('click', close);
      sheet.querySelector('#ccChSend').addEventListener('click', function () {
        mod.suggestCharacter(book, {
          name: sheet.querySelector('#ccChName').value,
          role: sheet.querySelector('#ccChRole').value || null,
          description: sheet.querySelector('#ccChDesc').value
        }).then(function (r) { if (r && r.ok) close(); });
      });
    });
}

/* Merge proposal: pick character B from the visible cast, evidence required. */
function openMergeProposal(book, charAName, charARef, candidates) {
  var mod = cc();
  if (!mod) return;
  candidates = (candidates || []).filter(function (c) { return c.ref !== charARef && c.name !== charAName; });
  if (!candidates.length) { toast('Need at least two characters to propose a merge'); return; }
  ccSheet('Same person?',
    '<p class="note"><b>' + escHtml(charAName) + '</b> is the same person as…</p>' +
    '<select id="ccMgB" class="text-input" style="width:100%;margin:6px 0">' +
    candidates.map(function (c) { return '<option value="' + escHtml(c.ref) + '">' + escHtml(c.name) + '</option>'; }).join('') +
    '</select>' +
    '<textarea id="ccMgEv" class="text-input" rows="3" placeholder="Evidence (required) — e.g. "both appear in Chapter 12"" style="width:100%"></textarea>' +
    '<p class="note">Merges are never automatic — the curator reviews your evidence.</p>' +
    '<p style="margin-top:10px"><button class="btn" id="ccMgSend">Propose merge</button> ' +
    '<button class="btn ghost" id="ccMgCancel">Cancel</button></p>',
    function (sheet, close) {
      sheet.querySelector('#ccMgCancel').addEventListener('click', close);
      sheet.querySelector('#ccMgSend').addEventListener('click', function () {
        var b = sheet.querySelector('#ccMgB').value;
        var ev = sheet.querySelector('#ccMgEv').value;
        mod.proposeMerge(book, charARef, b, ev).then(function (r) { if (r && r.ok) close(); });
      });
    });
}

/* ---------- trigger warning suggestion (controlled taxonomy) ---------- */
function openTriggerPicker(book) {
  var mod = cc();
  if (!mod) return;
  mod.taxonomy().then(function (tax) {
    if (!tax.length) { toast('Warning catalog not loaded — try again shortly'); return; }
    var cats = {};
    tax.forEach(function (t) { (cats[t.category] = cats[t.category] || []).push(t); });
    var body = '<p class="note">Pick from the curated list — suggestions go to the curator. Applying a warning is deliberately easy; a missing one matters more than a wrong one.</p>' +
      '<input id="ccTgSearch" class="text-input" placeholder="Search warnings…" style="width:100%;margin:8px 0">' +
      '<div id="ccTgList" style="max-height:40vh;overflow:auto"></div>';
    ccSheet('Suggest a content warning', body, function (sheet, close) {
      var render = function (q) {
        q = String(q || '').toLowerCase();
        var html = '';
        Object.keys(cats).sort().forEach(function (cat) {
          var shown = cats[cat].filter(function (t) {
            return !q || t.label.toLowerCase().indexOf(q) >= 0 || t.id.indexOf(q) >= 0;
          });
          if (!shown.length) return;
          html += '<p class="note" style="margin:8px 0 4px;text-transform:capitalize">' + escHtml(cat.replace(/-/g, ' ')) + '</p>' +
            shown.map(function (t) {
              return '<button class="chip" data-cgid="' + escHtml(t.id) + '" title="' + escHtml(t.description || '') + '">' + escHtml(t.label) + '</button>';
            }).join(' ');
        });
        sheet.querySelector('#ccTgList').innerHTML = html || '<p class="note">No matches.</p>';
        sheet.querySelectorAll('[data-cgid]').forEach(function (b) {
          b.addEventListener('click', function () {
            mod.suggestTrigger(book, b.getAttribute('data-cgid')).then(function (r) { if (r && r.ok) close(); });
          });
        });
      };
      sheet.querySelector('#ccTgSearch').addEventListener('input', function (e) { render(e.target.value); });
      render('');
    });
  });
}

/* ---------- flywheel: merge accepted community warnings into the
   Start Reading trigger-check data source (PR #87) ---------- */
async function ccEnrichWarnings(b) {
  if (!b || b._ccWarnEnriched) return b;
  b._ccWarnEnriched = true;
  try {
    var mod = cc();
    if (!mod) return b;
    var sb = null;
    try { sb = await cloudClient().catch(function () { return null; }); } catch (e) {}
    if (!sb || typeof bookKeyFor !== 'function') return b;
    var key = bookKeyFor(b);
    var r = await sb.from('trigger_suggestions')
      .select('trigger_id, trigger_taxonomy(label)').eq('book_key', key).eq('status', 'accepted');
    var labels = [];
    (r.data || []).forEach(function (row) {
      var label = row.trigger_taxonomy && row.trigger_taxonomy.label;
      if (label) labels.push(label);
    });
    if (labels.length) {
      b.contentWarnings = b.contentWarnings || [];
      var have = {};
      b.contentWarnings.forEach(function (w) { have[String(w).toLowerCase()] = true; });
      labels.forEach(function (l) {
        if (!have[String(l).toLowerCase()]) { b.contentWarnings.push(l + ' (community)'); have[String(l).toLowerCase()] = true; }
      });
    }
  } catch (e) {}
  return b;
}

/* Patch the two PR #87 call sites: enrich before the check. */
function ccPatchTriggerCheck() {
  try {
    var s1 = document.getElementById('f-tropedb');
    void s1;
  } catch (e) {}
}
/* Expose enrichment for the patched call sites (see edits in
   150-modal-discovery.js and 160-roulette.js). */
window.ccEnrichWarnings = ccEnrichWarnings;

/* ---------- injection via MutationObserver ---------- */
function injectTropeSuggest(box) {
  if (!box || box.querySelector('#ccTropeSuggest')) return;
  if (!ccBook) return;
  var btn = document.createElement('p');
  btn.style.marginTop = '10px';
  btn.innerHTML = '<button class="btn sm ghost" id="ccTropeSuggest">Suggest a trope</button> ' +
    '<span class="note">from the curated catalog — reviewed by the curator</span>';
  box.appendChild(btn);
  btn.querySelector('#ccTropeSuggest').addEventListener('click', function () { openTropePicker(ccBook); });
}

function injectCharsSuggest(box) {
  if (!box || box.querySelector('#ccCharSuggest')) return;
  if (!ccBook) return;
  var book = ccBook;
  var wrap = document.createElement('div');
  wrap.innerHTML = '<p><button class="btn sm ghost" id="ccCharSuggest">Suggest a character</button> ' +
    '<span class="note">missing someone? reviewed by the curator</span></p>';
  box.insertBefore(wrap, box.firstChild);
  wrap.querySelector('#ccCharSuggest').addEventListener('click', function () { openCharacterSuggest(book); });
  /* merge affordance on each character card */
  var cards = box.querySelectorAll('.ch-card');
  var candidates = [];
  cards.forEach(function (card) {
    var link = card.querySelector('[data-chwiki], [data-chbook]');
    if (!link) return;
    var name = link.textContent.trim();
    var ref = link.getAttribute('data-chwiki') || link.getAttribute('data-chbook');
    candidates.push({ name: name, ref: ref });
  });
  cards.forEach(function (card, i) {
    if (card.querySelector('.cc-merge')) return;
    var link = card.querySelector('[data-chwiki], [data-chbook]');
    if (!link) return;
    var c = candidates[i];
    var m = document.createElement('button');
    m.className = 'taplink cc-merge';
    m.style.cssText = 'font-size:11px;opacity:.7';
    m.textContent = 'same person?';
    m.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openMergeProposal(book, c.name, c.ref, candidates);
    });
    card.appendChild(m);
  });
}

function injectTriggerSuggest(details) {
  if (!details || details.querySelector('#ccTriggerSuggest')) return;
  if (!ccBook) return;
  var book = ccBook;
  var p = document.createElement('p');
  p.style.marginTop = '8px';
  p.innerHTML = '<button class="taplink" id="ccTriggerSuggest" style="font-size:12px">Suggest a warning</button> ' +
    '<span class="note">spotted one that\'s missing?</span>';
  details.appendChild(p);
  p.querySelector('#ccTriggerSuggest').addEventListener('click', function () { openTriggerPicker(book); });
}

var ccObserver = null;
function ccWatch() {
  if (ccObserver) return;
  /* Stash the current book whenever the detail modal renders. */
  var origOpen = null;
  ccObserver = new MutationObserver(function () {
    var tropedb = document.getElementById('m-tropedb');
    if (tropedb) injectTropeSuggest(tropedb);
    var chars = document.getElementById('m-charstab');
    if (chars) injectCharsSuggest(chars);
    var warns = document.querySelector('details.warnings');
    if (warns) injectTriggerSuggest(warns);
  });
  ccObserver.observe(document.body, { childList: true, subtree: true });
}
/* Called by the modal render (patched into 150-modal-discovery.js). */
window.ccSetBook = function (b) { ccBook = b || null; };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ccWatch);
else ccWatch();

/* Flush the offline outbox when we come back online. */
try {
  window.addEventListener('online', function () {
    if (cc() && cc().flushOutbox) cc().flushOutbox();
  });
  setTimeout(function () { if (cc() && cc().flushOutbox) cc().flushOutbox(); }, 8000);
} catch (e) {}

})();
