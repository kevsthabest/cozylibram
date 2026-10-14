/* ---- Reading nudges v1 (v468): gentle mid-read prompts, signal-based.
   Never percentage-based (page counts lie). One question max per prompt.
   Dismissible per book. Warnings are NEVER prompted mid-read.

   v1 signals:
   S1: 3rd reading session + 0 characters recorded → "Met anyone worth naming?"
   S3: 5th session + 0 tropes → "Spotted any of these yet?" (yes/no chips)
   (S2 waits on character favorites — out of scope for v1.)

   Caps: max 2 prompts per book ever, min 7 days between prompts,
   never in the same session the survey fired, never when DNA >= 80%.
   Renders as an inline card at the top of the Library home's reading
   area — glanceable and ignorable, never a modal.
*/
(function () {
'use strict';

function dnaNudgesOff() {
  try { return localStorage.getItem('cozylibram.dnaNudgesOff') === '1'; } catch (e) { return false; }
}
function daysSince(ts) {
  if (!ts) return Infinity;
  return (Date.now() - ts) / 86400000;
}
function promptCount(b) { return b.dnaPromptCount || 0; }
// v496 (#137): in-flight guard for nudgeEvaluate (see below).
var nudgeEvaluating = false;

function nudgeSlotHTML() { return '<div id="nudgeSlot"></div>'; }

function localTropeCount(b) {
  var n = 0;
  try { n = (typeof portraitLocalTropes === 'function') ? portraitLocalTropes(b).length : (b.tropes || []).length; }
  catch (e) { n = (b.tropes || []).length; }
  return n;
}
function dnaPct(b) {
  try { return (typeof portraitScore === 'function') ? portraitScore(b, 0) : 0; }
  catch (e) { return 0; }
}

async function nudgeEvaluate() {
  var slot = document.getElementById('nudgeSlot');
  if (!slot) return;
  // v496 (#137): in-flight guard — two overlapping evaluations could both
  // pass the promptCount < 2 filter before either increments, burning both
  // lifetime prompts on one nudge.
  if (nudgeEvaluating) return;
  nudgeEvaluating = true;
  try {
    if (dnaNudgesOff()) return;
    var lib = (typeof library !== 'undefined') ? library : [];
    var candidates = lib.filter(function (b) {
      return b && b.status === 'reading' && !b.dnaNudgeNever && promptCount(b) < 2 &&
        daysSince(b.dnaPromptAt) >= 7 && dnaPct(b) < 80;
    });
    if (!candidates.length) return;
    // prefer the book with the most sessions (closest to a signal)
    candidates.sort(function (a, b2) { return (b2.readSessions || 0) - (a.readSessions || 0); });
    for (var i = 0; i < candidates.length; i++) {
      var sig = await nudgeSignal(candidates[i]);
      if (sig) { renderNudge(slot, candidates[i], sig); return; }
    }
  } catch (e) {}
  finally { nudgeEvaluating = false; }
}

async function nudgeSignal(b) {
  var sessions = b.readSessions || 0;
  // S1: characters
  if (sessions >= 3) {
    var cc = null;
    try { cc = (typeof portraitCharCount === 'function') ? await portraitCharCount(b) : null; } catch (e) {}
    if (cc === 0) return { kind: 'chars' };
    // cc === null (offline/unknown) → can't confirm; skip character signal
  }
  // S3: tropes (last-resort nudge)
  if (sessions >= 5 && localTropeCount(b) === 0 && !b.dnaTropesNone) {
    return { kind: 'tropes' };
  }
  return null;
}

function nudgeTropePicks() {
  var ids = ['enemies-to-lovers', 'forced-proximity', 'slow-burn'];
  var out = [];
  try {
    ids.forEach(function (id) {
      var t = (typeof TropeTaxonomy !== 'undefined' && TropeTaxonomy.byId) ? TropeTaxonomy.byId(id) : null;
      out.push({ id: id, name: (t && t.name) || id });
    });
  } catch (e) {
    return ids.map(function (id) { return { id: id, name: id }; });
  }
  return out;
}

function renderNudge(slot, b, sig) {
  var inner = '';
  if (sig.kind === 'chars') {
    inner =
      '<div class="portrait-label">A quick question</div>' +
      '<p><b>' + esc(b.title || 'This book') + '</b> — met anyone worth naming?</p>' +
      '<div class="survey-row"><input id="nudgeName" class="text-input" placeholder="Character name" style="flex:1">' +
      '<button class="btn sm" id="nudgeSend">Send</button></div>';
  } else {
    inner =
      '<div class="portrait-label">A quick question</div>' +
      '<p><b>' + esc(b.title || 'This book') + '</b> — spotted any of these yet?</p>' +
      '<div class="survey-chips" id="nudgeChips">' +
      nudgeTropePicks().map(function (t) {
        return '<button class="chip nudge-chip" data-ntid="' + esc(t.id) + '">' + esc(t.name) + '</button>';
      }).join('') + '</div>' +
      '<p class="note">Tap the ones you\u2019ve noticed — or skip.</p>' +
      '<button class="btn sm" id="nudgeSend">Send</button>';
  }
  slot.innerHTML =
    '<div class="nudge-card"><button class="nudge-x" id="nudgeDismiss" aria-label="Dismiss">×</button>' +
    inner +
    '<div class="nudge-foot"><button class="taplink" id="nudgeSkip">Skip</button> · ' +
    '<button class="taplink" id="nudgeNever">Don\u2019t ask for this book</button></div></div>';

  // mark shown (counts toward the 2-prompt cap + 7-day cooldown)
  b.dnaPromptAt = Date.now();
  b.dnaPromptCount = promptCount(b) + 1;
  try { if (typeof saveLibrary === 'function') saveLibrary(); } catch (e) {}

  var clear = function () { slot.innerHTML = ''; };
  slot.querySelector('#nudgeDismiss').addEventListener('click', clear);
  slot.querySelector('#nudgeSkip').addEventListener('click', clear);
  slot.querySelector('#nudgeNever').addEventListener('click', function () {
    b.dnaNudgeNever = true;
    try { if (typeof saveLibrary === 'function') saveLibrary(); } catch (e) {}
    clear();
  });

  var picked = {};
  slot.querySelectorAll('.nudge-chip').forEach(function (c) {
    c.addEventListener('click', function () {
      var id = c.getAttribute('data-ntid');
      if (picked[id]) { delete picked[id]; c.classList.remove('on'); }
      else { picked[id] = 1; c.classList.add('on'); }
    });
  });

  slot.querySelector('#nudgeSend').addEventListener('click', async function () {
    // v496 (#137): double-tap guard — the send is async and there is no
    // server-side unique constraint on character suggestions.
    var btn = slot.querySelector('#nudgeSend');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var mod = (typeof window.CommunityCorpus !== 'undefined') ? window.CommunityCorpus : null;
    var sent = 0;
    var quiet = { quiet: true };
    try {
      if (mod) {
        if (sig.kind === 'chars') {
          var name = (slot.querySelector('#nudgeName').value || '').trim();
          if (name) { var r = await mod.suggestCharacter(b, { name: name }, quiet); if (r && r.ok) sent++; }
        } else {
          var ids = Object.keys(picked);
          for (var i = 0; i < ids.length; i++) {
            try { var r2 = await mod.suggestTrope(b, ids[i], quiet); if (r2 && r2.ok) sent++; } catch (e) {}
          }
        }
      }
    } catch (e) {}
    clear();
    try { toast(sent ? 'Thank you 🤎' : 'Noted'); } catch (e) {}
  });
}

if (typeof window !== 'undefined') {
  window.nudgeSlotHTML = nudgeSlotHTML;
  window.nudgeEvaluate = nudgeEvaluate;
  window.dnaNudgesOff = dnaNudgesOff;
}
})();
