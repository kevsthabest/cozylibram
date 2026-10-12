/* ---- Post-completion survey v1 (v468): a kind, optional survey the first
   time a book is marked read. Three one-tap sections (tropes, characters,
   warnings); Skip and "don't ask again" are first-class. Answers flow
   through the existing CommunityCorpus suggestion APIs — the survey is a
   friendlier input surface; the pipeline underneath doesn't change.

   Guards (never nag):
   - completeness >= 90% → nothing meaningful to ask
   - b.dnaSurveySeen / b.dnaSurveyNever → per-book flags
   - localStorage cozylibram.dnaSurveyOff === '1' → global off
   - re-read (readCount > 1) with a prior survey → only if DNA < 50%
*/
(function () {
'use strict';

function escH(s) {
  try { return (typeof esc === 'function') ? esc(s) : String(s); }
  catch (e) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
}
function dnaSurveyOff() {
  try { return localStorage.getItem('cozylibram.dnaSurveyOff') === '1'; } catch (e) { return false; }
}

function dnaSurveyEligible(b) {
  if (!b || b.status !== 'read') return false;
  if (dnaSurveyOff()) return false;
  if (b.dnaSurveySeen || b.dnaSurveyNever) return false;
  var pct = 0;
  try { pct = (typeof portraitScore === 'function') ? portraitScore(b, 0) : 0; } catch (e) {}
  if (pct >= 90) return false;
  // re-reads: only re-ask when the portrait is still thin
  if ((b.readCount || 0) > 1 && b.dnaSurveyCompletedOnce && pct >= 50) return false;
  return true;
}

function maybeShowDnaSurvey(b) {
  try {
    if (!dnaSurveyEligible(b)) return;
    // mark seen up-front so a second completion event can't double-fire
    b.dnaSurveySeen = true;
    if (typeof saveLibrary === 'function') saveLibrary();
    openDnaSurvey(b);
  } catch (e) {}
}

/* ---------- sheet ---------- */
var surveySel = { tropes: {}, warns: {} };
// v496 (#139): overlay-manager tokens for the two sheets in this file —
// the Android back gesture dismisses instead of exiting the app.
var dnaSurveyToken = null;
var warnPrefToken = null;

function tropeOptions() {
  var out = [];
  try {
    if (typeof TropeTaxonomy !== 'undefined' && TropeTaxonomy.list) {
      TropeTaxonomy.list().forEach(function (t) { out.push({ id: t.id, name: t.name || t.id }); });
    }
  } catch (e) {}
  return out;
}
async function warnOptions() {
  try {
    if (typeof window.CommunityCorpus !== 'undefined' && window.CommunityCorpus.taxonomy) {
      var rows = await window.CommunityCorpus.taxonomy();
      return (rows || []).map(function (r) { return { id: r.id, label: r.label || r.id }; });
    }
  } catch (e) {}
  return [];
}

function chipRow(items, group, labelKey) {
  return '<div class="survey-chips">' + items.map(function (it) {
    var label = it[labelKey] || it.id;
    return '<button class="chip survey-chip" data-sg="' + group + '" data-sid="' + escH(it.id) + '">' + escH(label) + '</button>';
  }).join('') + '</div>';
}

function openDnaSurvey(b) {
  if (document.getElementById('dnaSurveySheet')) return;
  surveySel = { tropes: {}, warns: {} };
  var pct = 0;
  try { pct = (typeof portraitScore === 'function') ? portraitScore(b, 0) : 0; } catch (e) {}

  var tropes = tropeOptions();
  var body =
    '<div class="survey-inner">' +
    '<p class="survey-title">You finished it! 🎉</p>' +
    '<p class="note">This book\u2019s portrait is ' + pct + '% mapped. Help the next reader know what they\u2019re getting into?</p>' +
    '<div class="survey-sec"><div class="portrait-label">What kind of story was it? <span class="note">tap all that fit</span></div>' +
    '<input id="svTropeSearch" class="text-input" placeholder="Search tropes…" style="width:100%;margin:6px 0">' +
    '<div id="svTropeChips" style="max-height:22vh;overflow:auto"></div>' +
    '<label class="checkline" style="margin-top:6px"><input type="checkbox" id="svTropesNone"> None of these fit</label></div>' +
    '<div class="survey-sec"><div class="portrait-label">Who mattered? <span class="note">names only, no spoilers needed</span></div>' +
    '<div id="svNames"><input class="text-input sv-name" placeholder="Character name" style="width:100%;margin:4px 0"></div>' +
    '<button class="taplink" id="svAddName">+ add another</button></div>' +
    '<div class="survey-sec"><div class="portrait-label">Anything future readers should know about?</div>' +
    '<div id="svWarnChips"><p class="note">Loading warnings…</p></div>' +
    '<p class="note" style="margin-top:4px">If you\u2019re not sure, flag it — a wrong warning is easier to remove than a missing one is to forgive.</p></div>' +
    '<div class="survey-actions">' +
    '<button class="btn" id="svSend">Send — thank you 🤎</button> ' +
    '<button class="btn ghost" id="svSkip">Skip</button></div>' +
    '<button class="taplink" id="svNever" style="margin-top:8px">Don\u2019t ask me about this book again</button>' +
    '</div>';

  var scrim = document.createElement('div');
  scrim.className = 'sv-scrim'; scrim.id = 'dnaSurveyScrim';
  var sheet = document.createElement('div');
  sheet.className = 'sv-sheet survey-sheet'; sheet.id = 'dnaSurveySheet';
  sheet.innerHTML = body;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  requestAnimationFrame(function () { sheet.classList.add('open'); });

  var close = function () {
    // v496 (#139): consume the overlay entry so the Android back gesture
    // dismisses the sheet instead of exiting the app. A back-gesture close
    // already popped the entry (overlayClosed then no-ops); null the token
    // so a second close() is harmless.
    var t = dnaSurveyToken; dnaSurveyToken = null;
    if (t && typeof overlayClosed === 'function') { try { overlayClosed(t); } catch (e) {} }
    sheet.classList.remove('open');
    setTimeout(function () {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    }, 250);
  };
  // v496 (#139): register with the overlay manager so the Android back
  // gesture dismisses the sheet instead of exiting the app.
  dnaSurveyToken = (typeof overlayOpened === 'function') ? overlayOpened('dna-survey', close) : null;

  // trope chips with search
  var renderTropes = function (q) {
    q = String(q || '').toLowerCase();
    var shown = tropes.filter(function (t) {
      return !q || t.name.toLowerCase().indexOf(q) >= 0 || t.id.indexOf(q) >= 0;
    }).slice(0, 80);
    var box = sheet.querySelector('#svTropeChips');
    if (box) box.innerHTML = chipRow(shown, 'tropes', 'name') || '<p class="note">No matches.</p>';
  };
  renderTropes('');
  sheet.querySelector('#svTropeSearch').addEventListener('input', function (e) { renderTropes(e.target.value); });

  // warning chips (async taxonomy)
  warnOptions().then(function (rows) {
    var box = sheet.querySelector('#svWarnChips');
    if (!box || !box.isConnected) return;
    box.innerHTML = rows.length ? chipRow(rows, 'warns', 'label') : '<p class="note">Warning list unavailable offline — you can suggest one from the book page later.</p>';
  });

  // chip toggle (delegated)
  sheet.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('.survey-chip') : null;
    if (c) {
      var g = c.getAttribute('data-sg'), id = c.getAttribute('data-sid');
      if (surveySel[g][id]) { delete surveySel[g][id]; c.classList.remove('on'); }
      else { surveySel[g][id] = 1; c.classList.add('on'); }
    }
  });
  sheet.querySelector('#svAddName').addEventListener('click', function () {
    var inp = document.createElement('input');
    inp.className = 'text-input sv-name';
    inp.placeholder = 'Character name';
    inp.style.cssText = 'width:100%;margin:4px 0';
    sheet.querySelector('#svNames').appendChild(inp);
    inp.focus();
  });

  var finish = function (mode) {
    // mode: 'send' | 'skip' | 'never' — dnaSurveySeen was set on open
    if (mode === 'never') b.dnaSurveyNever = true;
    if (typeof saveLibrary === 'function') saveLibrary();
    close();
  };
  sheet.querySelector('#svSkip').addEventListener('click', function () { finish('skip'); });
  sheet.querySelector('#svNever').addEventListener('click', function () { finish('never'); });
  scrim.addEventListener('click', function () { finish('skip'); });

  sheet.querySelector('#svSend').addEventListener('click', async function () {
    var btn = sheet.querySelector('#svSend');
    btn.disabled = true; btn.textContent = 'Sending…';
    var mod = (typeof window.CommunityCorpus !== 'undefined') ? window.CommunityCorpus : null;
    var ok = 0, total = 0;
    var quiet = { quiet: true };
    try {
      if (mod) {
        var tropeIds = Object.keys(surveySel.tropes);
        for (var i = 0; i < tropeIds.length; i++) {
          total++;
          try { var r = await mod.suggestTrope(b, tropeIds[i], quiet); if (r && r.ok) ok++; } catch (e) {}
        }
        if (sheet.querySelector('#svTropesNone').checked) { b.dnaTropesNone = true; }
        var names = Array.prototype.map.call(sheet.querySelectorAll('.sv-name'), function (x) { return x.value.trim(); }).filter(Boolean);
        for (var j = 0; j < names.length; j++) {
          total++;
          try { var r2 = await mod.suggestCharacter(b, { name: names[j] }, quiet); if (r2 && r2.ok) ok++; } catch (e) {}
        }
        var warnIds = Object.keys(surveySel.warns);
        for (var k = 0; k < warnIds.length; k++) {
          total++;
          try { var r3 = await mod.suggestTrigger(b, warnIds[k], quiet); if (r3 && r3.ok) ok++; } catch (e) {}
        }
      }
    } catch (e) {}
    b.dnaSurveyCompletedOnce = true;
    if (typeof saveLibrary === 'function') saveLibrary();
    close();
    try { toast(total ? ('Thank you — ' + ok + ' suggestion' + (ok === 1 ? '' : 's') + ' sent 🤎') : 'Thank you 🤎'); } catch (e) {}
  });
}

/* ---------- warning preferences (v468) ----------
   Private per-device store: which warnings to exclude from discovery,
   which to surface prominently, and how much detail to show. */
function getWarningPrefs() {
  var d = { excluded: [], prominent: [], detail: 'gentle' };
  try {
    var raw = localStorage.getItem('cozylibram.warningPrefs.v1');
    if (raw) {
      var p = JSON.parse(raw);
      if (Array.isArray(p.excluded)) d.excluded = p.excluded;
      if (Array.isArray(p.prominent)) d.prominent = p.prominent;
      if (['gentle', 'detailed', 'on-request'].indexOf(p.detail) >= 0) d.detail = p.detail;
    }
  } catch (e) {}
  return d;
}
function openWarningPrefs() {
  if (document.getElementById('warnPrefSheet')) return;
  var prefs = getWarningPrefs();
  var sel = { excluded: {}, prominent: {} };
  prefs.excluded.forEach(function (id) { sel.excluded[id] = 1; });
  prefs.prominent.forEach(function (id) { sel.prominent[id] = 1; });
  var detail = prefs.detail;

  var body =
    '<div class="survey-inner">' +
    '<p class="survey-title">Content warning preferences</p>' +
    '<p class="note">Private to this device. These shape how warnings appear for you — never shared.</p>' +
    '<div class="survey-sec"><div class="portrait-label">How much detail?</div>' +
    '<div class="seg" id="wpDetail" style="grid-template-columns:repeat(3,1fr)">' +
    [['gentle', 'Gentle'], ['detailed', 'Detailed'], ['on-request', 'On request']].map(function (o) {
      return '<button data-wd="' + o[0] + '" class="' + (detail === o[0] ? 'active' : '') + '">' + o[1] + '</button>';
    }).join('') + '</div></div>' +
    '<div class="survey-sec"><div class="portrait-label">Surface first <span class="note">always shown prominently</span></div>' +
    '<div id="wpProminent"><p class="note">Loading…</p></div></div>' +
    '<div class="survey-sec"><div class="portrait-label">Filter from discovery <span class="note">hide books with these</span></div>' +
    '<div id="wpExcluded"><p class="note">Loading…</p></div></div>' +
    '<div class="survey-actions"><button class="btn" id="wpSave">Save preferences</button> ' +
    '<button class="btn ghost" id="wpCancel">Cancel</button></div></div>';

  var scrim = document.createElement('div');
  scrim.className = 'sv-scrim'; scrim.id = 'warnPrefScrim';
  var sheet = document.createElement('div');
  sheet.className = 'sv-sheet survey-sheet'; sheet.id = 'warnPrefSheet';
  sheet.innerHTML = body;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  requestAnimationFrame(function () { sheet.classList.add('open'); });
  var close = function () {
    // v496 (#139): consume the overlay entry (see openDnaSurvey's close).
    var t = warnPrefToken; warnPrefToken = null;
    if (t && typeof overlayClosed === 'function') { try { overlayClosed(t); } catch (e) {} }
    sheet.classList.remove('open');
    setTimeout(function () {
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    }, 250);
  };
  // v496 (#139): register with the overlay manager (Android back dismisses).
  warnPrefToken = (typeof overlayOpened === 'function') ? overlayOpened('warn-prefs', close) : null;

  sheet.querySelectorAll('#wpDetail button').forEach(function (b) {
    b.addEventListener('click', function () {
      detail = b.getAttribute('data-wd');
      sheet.querySelectorAll('#wpDetail button').forEach(function (x) { x.classList.toggle('active', x === b); });
    });
  });
  var fill = function (boxId, group) {
    warnOptions().then(function (rows) {
      var box = sheet.querySelector('#' + boxId);
      if (!box || !box.isConnected) return;
      box.innerHTML = rows.length ? '<div class="survey-chips">' + rows.map(function (r) {
        return '<button class="chip survey-chip' + (sel[group][r.id] ? ' on' : '') + '" data-wg="' + group + '" data-wid="' + escH(r.id) + '">' + escH(r.label) + '</button>';
      }).join('') + '</div>' : '<p class="note">Warning list needs internet — try again when you\u2019re back online.</p>';
    });
  };
  fill('wpProminent', 'prominent');
  fill('wpExcluded', 'excluded');
  sheet.addEventListener('click', function (e) {
    var c = e.target && e.target.closest ? e.target.closest('.survey-chip') : null;
    if (c) {
      var g = c.getAttribute('data-wg'), id = c.getAttribute('data-wid');
      if (sel[g][id]) { delete sel[g][id]; c.classList.remove('on'); }
      else { sel[g][id] = 1; c.classList.add('on'); }
    }
  });
  sheet.querySelector('#wpCancel').addEventListener('click', close);
  scrim.addEventListener('click', close);
  sheet.querySelector('#wpSave').addEventListener('click', function () {
    var out = { excluded: Object.keys(sel.excluded), prominent: Object.keys(sel.prominent), detail: detail };
    try { localStorage.setItem('cozylibram.warningPrefs.v1', JSON.stringify(out)); } catch (e) {}
    close();
    try { toast('Warning preferences saved'); } catch (e) {}
  });
}

if (typeof window !== 'undefined') {
  window.maybeShowDnaSurvey = maybeShowDnaSurvey;
  window.dnaSurveyEligible = dnaSurveyEligible;
  window.dnaSurveyOff = dnaSurveyOff;
  window.openDnaSurvey = openDnaSurvey;
  window.openWarningPrefs = openWarningPrefs;
  window.getWarningPrefs = getWarningPrefs;
}
if (typeof module !== 'undefined') module.exports = { dnaSurveyEligible: dnaSurveyEligible };
})();
