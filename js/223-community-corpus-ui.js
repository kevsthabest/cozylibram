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
// v496 (#136): module-scoped overlay token — closeCcSheet passes it to
// overlayClosed so programmatic closes (scrim tap, successful send,
// step-1→step-2 handoffs) don't leak phantom history entries.
var ccSheetToken = null;
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
  ccSheetToken = (typeof overlayOpened === 'function') ? overlayOpened('cc-sheet', closeCcSheet) : null;
  scrim.addEventListener('click', closeCcSheet);
  if (typeof onMount === 'function') onMount(sheet, closeCcSheet);
  return closeCcSheet;
}
function closeCcSheet() {
  ['ccScrim', 'ccSheet'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
  // Consume the token first: a back-gesture close already popped the entry
  // (overlayClosed then no-ops), and a second closeCcSheet() finds null.
  var t = ccSheetToken; ccSheetToken = null;
  if (t && typeof overlayClosed === 'function') { try { overlayClosed(t); } catch (e) {} }
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
    '<p class="cc-trust" style="text-align:left;margin:0 0 4px">Pick from the curated catalog — suggestions go to the curator for review.</p>' +
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
    '<p class="cc-trust" style="text-align:left">Ideas outside the catalog go to the curator — they\'re never added automatically.</p>' +
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

/* ---------- character suggestion: Variant A (Conversation) ----------
   One question at a time in a bottom sheet — feels like chatting, not
   form-filling. Step 1: name ("Who did we miss?"). Step 2: role + description. */
function openCharacterSuggest(book) {
  var mod = cc();
  if (!mod) return;
  ccSheet('Who did we miss?',
    '<p class="note" style="margin-bottom:12px">Just the name for now — you can add more if you like.</p>' +
    '<input id="ccChName" class="text-input" placeholder="Character name" style="width:100%" autocomplete="off">' +
    '<p style="margin-top:14px"><button class="btn" id="ccChNext" style="width:100%">Continue &rarr;</button></p>' +
    '<p class="cc-trust">Goes to the curator for review. Never auto-added.</p>',
    function (sheet, close) {
      var inp = sheet.querySelector('#ccChName');
      var next = function () {
        var name = inp.value.trim();
        if (!name) { toast('Give them a name first'); inp.focus(); return; }
        openCharacterSuggestStep2(book, name);
      };
      sheet.querySelector('#ccChNext').addEventListener('click', next);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') next(); });
      if (inp) inp.focus();
    });
}

function openCharacterSuggestStep2(book, name) {
  var mod = cc();
  if (!mod) return;
  ccSheet('Who did we miss?',
    '<p class="note" style="margin-bottom:12px">Adding <b>' + escHtml(name) + '</b> — anything more? <button class="taplink" id="ccChBack">&larr; edit name</button></p>' +
    '<label class="cc-label">What kind of role? (optional)</label>' +
    '<select id="ccChRole" class="text-input" style="width:100%;margin:6px 0">' +
    '<option value="">Pick a role&hellip;</option>' +
    '<option value="protagonist">Protagonist</option>' +
    '<option value="antagonist">Antagonist</option>' +
    '<option value="supporting">Supporting</option>' +
    '<option value="minor">Minor</option></select>' +
    '<textarea id="ccChDesc" class="text-input" rows="3" placeholder="Who are they? (a sentence or two)" style="width:100%"></textarea>' +
    '<p style="margin-top:12px"><button class="btn" id="ccChSend" style="width:100%">Suggest ' + escHtml(name) + ' &rarr;</button></p>' +
    '<p class="cc-trust">Goes to the curator for review. Never auto-added.</p>',
    function (sheet, close) {
      sheet.querySelector('#ccChBack').addEventListener('click', function () { openCharacterSuggest(book); });
      sheet.querySelector('#ccChSend').addEventListener('click', function () {
        mod.suggestCharacter(book, {
          name: name,
          role: sheet.querySelector('#ccChRole').value || null,
          description: sheet.querySelector('#ccChDesc').value
        }).then(function (r) { if (r && r.ok) close(); });
      });
    });
}

/* Merge proposal: Variant A — side-by-side cards + required evidence.
   Evidence is enforced client-side (toast + focus); the curator still
   reviews every proposal. Merges are never automatic. */
function openMergeProposal(book, charAName, charARef, candidates) {
  var mod = cc();
  if (!mod) return;
  candidates = (candidates || []).filter(function (c) { return c.ref !== charARef && c.name !== charAName; });
  if (!candidates.length) { toast('Need at least two characters to propose a merge'); return; }
  var avatarFor = function (name) {
    var ch = String(name || '?').trim().charAt(0).toUpperCase() || '?';
    return '<div class="cc-merge-avatar">' + escHtml(ch) + '</div>';
  };
  var cardsHTML = function (bName) {
    return '<div class="cc-merge-cards">' +
      '<div class="cc-merge-card">' + avatarFor(charAName) +
      '<div class="cc-merge-name">' + escHtml(charAName) + '</div></div>' +
      '<div class="cc-merge-vs">is</div>' +
      '<div class="cc-merge-card">' + avatarFor(bName) +
      '<div class="cc-merge-name">' + escHtml(bName) + '</div></div>' +
      '</div>';
  };
  ccSheet('Are these the same person?',
    '<div id="ccMgCards">' + cardsHTML(candidates[0].name) + '</div>' +
    '<label class="cc-label">The same person as&hellip;</label>' +
    '<select id="ccMgB" class="text-input" style="width:100%;margin:6px 0">' +
    candidates.map(function (c) { return '<option value="' + escHtml(c.ref) + '">' + escHtml(c.name) + '</option>'; }).join('') +
    '</select>' +
    '<label class="cc-label">Evidence (required)</label>' +
    '<textarea id="ccMgEv" class="text-input" rows="3" placeholder="Where did you see this? e.g. both appear in Chapter 12" style="width:100%"></textarea>' +
    '<p class="cc-trust">Merges are never automatic — the curator reviews your evidence.</p>' +
    '<p style="margin-top:10px"><button class="btn" id="ccMgSend" style="width:100%">Propose merge</button> ' +
    '<button class="btn ghost" id="ccMgCancel">Cancel</button></p>',
    function (sheet, close) {
      var sel = sheet.querySelector('#ccMgB');
      var cards = sheet.querySelector('#ccMgCards');
      sel.addEventListener('change', function () {
        var opt = sel.options[sel.selectedIndex];
        cards.innerHTML = cardsHTML(opt ? opt.text : '');
      });
      sheet.querySelector('#ccMgCancel').addEventListener('click', close);
      sheet.querySelector('#ccMgSend').addEventListener('click', function () {
        var ev = sheet.querySelector('#ccMgEv').value.trim();
        if (!ev) {
          toast('Evidence is required — where did you see this?');
          sheet.querySelector('#ccMgEv').focus();
          return;
        }
        mod.proposeMerge(book, charARef, sel.value, ev).then(function (r) { if (r && r.ok) close(); });
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
    var body = '<p class="cc-trust" style="text-align:left;margin:0 0 4px">Pick from the curated list — suggestions go to the curator. Applying a warning is deliberately easy; a missing one matters more than a wrong one.</p>' +
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
  if (!b) return b;
  // v496 (#135): no _ccWarnEnriched flag on the book. The flag used to be
  // stamped on the live object, shipped cross-device inside bookToRow's data
  // payload, and never reset — newly accepted community warnings then stayed
  // invisible for that book forever. The merge below is idempotent (dedups
  // against both the raw and ' (community)' suffixed forms), so re-running on
  // every modal open is safe; it's one indexed query.
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
        var k = String(l).toLowerCase();
        // v496 (#135): idempotent merge — a second run must not re-append.
        // Check both the raw label and the suffixed form we store.
        if (!have[k] && !have[k + ' (community)']) {
          b.contentWarnings.push(l + ' (community)');
          have[k] = true; have[k + ' (community)'] = true;
        }
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
  btn.innerHTML = '<button class="btn sm ghost cc-entry" id="ccTropeSuggest">Suggest a trope</button> ' +
    '<span class="note">from the curated catalog — reviewed by the curator</span>';
  box.appendChild(btn);
  btn.querySelector('#ccTropeSuggest').addEventListener('click', function () { openTropePicker(ccBook); });
}

function injectCharsSuggest(box) {
  if (!box || box.querySelector('#ccCharSuggest')) return;
  if (!ccBook) return;
  var book = ccBook;
  var wrap = document.createElement('div');
  wrap.innerHTML = '<p><button class="btn sm ghost cc-entry" id="ccCharSuggest">Who did we miss?</button> ' +
    '<span class="note">reviewed by the curator</span></p>';
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
  p.innerHTML = '<button class="taplink cc-entry" id="ccTriggerSuggest" style="font-size:12px">Suggest a warning</button> ' +
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
/* v468: Book Portrait card contribution invites reuse these flows. */
window.ccSuggest = {
  trope: function (b) { openTropePicker(b || ccBook); },
  character: function (b) { openCharacterSuggest(b || ccBook); },
  warning: function (b) { openTriggerPicker(b || ccBook); }
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ccWatch);
else ccWatch();

/* Flush the offline outbox when we come back online. */
try {
  window.addEventListener('online', function () {
    if (cc() && cc().flushOutbox) cc().flushOutbox();
  });
  setTimeout(function () { if (cc() && cc().flushOutbox) cc().flushOutbox(); }, 8000);
} catch (e) {}

// v496 (#136): exposed for tests — overlay token round-trip.
if (typeof window !== 'undefined') { window.ccSheet = ccSheet; window.closeCcSheet = closeCcSheet; }

})();
