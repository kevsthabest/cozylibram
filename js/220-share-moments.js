/* ---- Shareable moments (v455): one-tap share images for milestones,
   Reading DNA, and 3D shelf "shelfies". Growth loop for a BookTok-style app.

   Pattern: canvas 1080x1920 card -> shareCanvasFile() (Web Share API with
   download fallback), same as drawBookCard/shareBookCard in js/170-stats.js.

   - drawMilestoneCard(id) / shareMilestoneCard(id): milestone achievement cards.
     Milestone rows on the Milestones page get a share button (wired here).
   - shareShelfie(): captures the Three.js canvas (synchronous render +
     toDataURL in the same task, so no preserveDrawingBuffer cost), composes
     it onto a branded card, shares it. Button lives in the 3D shelf menu.
   - Reading DNA share already exists (js/212-dna.js: shareDnaImage) — this
     module only verifies wiring; no duplicate implementation.
---- */

/* Milestone icon name -> emoji for canvas cards. */
var MILESTONE_ICON_EMOJI = {
  sprout: '🌱', covers: '📚', library: '🏛️', trophy: '🏆',
  flame: '🔥', crown: '👑', leaf: '🍂', star: '⭐',
  heart: '💛', compass: '🧭', bookmark: '🔖', quill: '🪶',
  flask: '⚗️', sparkles: '✨'
};

function milestoneCardEmoji(iconName) {
  return MILESTONE_ICON_EMOJI[iconName] || '✨';
}

/* Resolve a milestone ID to its full definition (catalog or dynamic). */
function shareableMilestoneDef(id) {
  var store = (typeof loadMilestones === 'function') ? loadMilestones() : {};
  var st = store[id];
  if (!st) return null;
  var def = (typeof milestoneDef === 'function')
    ? milestoneDef(id, st)
    : (typeof MILESTONE_CATALOG !== 'undefined'
      ? MILESTONE_CATALOG.find(function (m) { return m.id === id; })
      : null);
  if (!def) return null;
  return { def: def, state: st };
}

/* Draw a 1080x1920 milestone achievement card. Returns canvas or null. */
function drawMilestoneCard(id) {
  var resolved = shareableMilestoneDef(id);
  if (!resolved) return null;
  var def = resolved.def, st = resolved.state;
  var c = (typeof cardCanvas === 'function')
    ? cardCanvas([[0, '#241532'], [0.55, '#1c1028'], [1, '#0e0916']])
    : null;
  if (!c) return null;
  var cv = c.cv, x = c.x, W = c.W, H = c.H, C = c.C;
  var ink = C.ink, mut = C.mut, gold = C.gold;

  // Soft gold glow behind the icon
  var glow = x.createRadialGradient(W / 2, 620, 40, W / 2, 620, 560);
  glow.addColorStop(0, 'rgba(229,184,106,.22)');
  glow.addColorStop(1, 'rgba(229,184,106,0)');
  x.fillStyle = glow;
  x.fillRect(0, 0, W, H);

  x.textAlign = 'center';
  try { x.letterSpacing = '14px'; } catch (e) {}
  x.fillStyle = mut;
  x.font = '40px system-ui, sans-serif';
  x.fillText('COZY LIBRAM', W / 2, 150);
  try { x.letterSpacing = '0px'; } catch (e) {}

  // Icon medallion
  x.fillStyle = 'rgba(229,184,106,.14)';
  x.beginPath(); x.arc(W / 2, 560, 190, 0, Math.PI * 2); x.fill();
  x.strokeStyle = 'rgba(229,184,106,.45)'; x.lineWidth = 3;
  x.beginPath(); x.arc(W / 2, 560, 190, 0, Math.PI * 2); x.stroke();
  x.font = '190px system-ui, sans-serif';
  x.fillText(milestoneCardEmoji(def.icon), W / 2, 630);

  // Eyebrow
  var y = 880;
  try { x.letterSpacing = '8px'; } catch (e) {}
  x.fillStyle = gold;
  x.font = '36px system-ui, sans-serif';
  x.fillText('A READING MILESTONE', W / 2, y);
  try { x.letterSpacing = '0px'; } catch (e) {}
  y += 110;

  // Title (serif, wrapped)
  x.fillStyle = ink;
  x.font = 'bold 76px Georgia, serif';
  (typeof cvWrap === 'function' ? cvWrap(x, def.title, W - 200) : [def.title])
    .slice(0, 3).forEach(function (t) { x.fillText(t, W / 2, y); y += 92; });
  y += 30;

  // Warm copy
  x.fillStyle = mut;
  x.font = '42px Georgia, serif';
  (typeof cvWrap === 'function' ? cvWrap(x, def.copy || '', W - 220) : [def.copy || ''])
    .slice(0, 4).forEach(function (t) { x.fillText(t, W / 2, y); y += 62; });
  y += 60;

  // Date earned
  x.fillStyle = gold;
  x.font = '38px system-ui, sans-serif';
  var dateStr = st.achievedAt
    ? 'Earned ' + new Date(st.achievedAt).toLocaleDateString(undefined,
      { month: 'long', day: 'numeric', year: 'numeric' })
    : 'Earned on my reading journey';
  x.fillText(dateStr, W / 2, y);

  if (typeof cardFooter === 'function') cardFooter(x, W);
  return cv;
}

function shareMilestoneCard(id) {
  var resolved = shareableMilestoneDef(id);
  if (!resolved) { toast('Milestone not found'); return; }
  toast('Making your card… ✨');
  var cv = drawMilestoneCard(id);
  if (!cv) { toast('Image export isn’t supported on this device'); return; }
  var safe = String(resolved.def.title || 'milestone').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'milestone';
  shareCanvasFile(cv, 'cozy-libram-' + safe + '.png', resolved.def.title);
  if (typeof track === 'function') track('milestone_shared', { id: id });
}

/* Wire share buttons on the Milestones page. Call after renderMilestones(). */
function wireMilestoneShare() {
  document.querySelectorAll('.ms-share').forEach(function (btn) {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      shareMilestoneCard(btn.dataset.ms);
    });
  });
}

/* ---- Shelfie: 3D shelf as a shareable image ---- */

/* Compose a Three.js canvas snapshot onto a branded 1080x1920 card. */
function drawShelfieCard(dataUrl, meta) {
  var c = (typeof cardCanvas === 'function')
    ? cardCanvas([[0, '#1d1229'], [0.6, '#150d20'], [1, '#0c0812']])
    : null;
  if (!c) return Promise.resolve(null);
  var cv = c.cv, x = c.x, W = c.W, H = c.H, C = c.C;
  var ink = C.ink, mut = C.mut, gold = C.gold, acc = C.acc;

  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      x.textAlign = 'center';
      try { x.letterSpacing = '12px'; } catch (e) {}
      x.fillStyle = mut;
      x.font = '38px system-ui, sans-serif';
      x.fillText('COZY LIBRAM', W / 2, 130);
      try { x.letterSpacing = '0px'; } catch (e) {}

      // Shelf snapshot, contain-fit with rounded frame
      var fw = W - 120, fh = 1080;
      var s = Math.min(fw / img.width, fh / img.height);
      var dw = Math.max(1, Math.round(img.width * s));
      var dh = Math.max(1, Math.round(img.height * s));
      var fx = Math.round((W - dw) / 2), fy = 190;
      x.save();
      x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = 50; x.shadowOffsetY = 20;
      if (typeof cvRoundRect === 'function') { cvRoundRect(x, fx, fy, dw, dh, 24); }
      else { x.beginPath(); x.rect(fx, fy, dw, dh); }
      x.clip();
      x.drawImage(img, fx, fy, dw, dh);
      x.restore();

      var y = fy + dh + 110;
      try { x.letterSpacing = '6px'; } catch (e) {}
      x.fillStyle = gold;
      x.font = '36px system-ui, sans-serif';
      x.fillText('MY COZY SHELF', W / 2, y);
      try { x.letterSpacing = '0px'; } catch (e) {}
      y += 90;

      x.fillStyle = ink;
      x.font = 'bold 64px Georgia, serif';
      var bits = [];
      if (meta && meta.books != null) bits.push(meta.books + (meta.books === 1 ? ' book' : ' books'));
      if (meta && meta.theme) bits.push(meta.theme);
      var line = bits.join('  ·  ') || 'My reading corner';
      (typeof cvWrap === 'function' ? cvWrap(x, line, W - 200) : [line])
        .slice(0, 2).forEach(function (t) { x.fillText(t, W / 2, y); y += 78; });

      if (typeof cardFooter === 'function') cardFooter(x, W);
      resolve(cv);
    };
    img.onerror = function () { resolve(null); };
    img.src = dataUrl;
  });
}

async function shareShelfie() {
  if (typeof Shelf3D === 'undefined' || !Shelf3D ||
      typeof Shelf3D.capture !== 'function') {
    toast('Open the 3D shelf first 📚');
    return;
  }
  toast('Snapping your shelfie… 📸');
  var dataUrl = null;
  try { dataUrl = Shelf3D.capture(); } catch (e) { dataUrl = null; }
  if (!dataUrl) { toast('Couldn’t capture the shelf'); return; }
  var meta = {};
  try {
    var books = (typeof shelfBooks === 'function') ? shelfBooks() : [];
    meta.books = books.length;
  } catch (e) {}
  try {
    meta.theme = (typeof getTheme === 'function')
      ? String(getTheme()).replace(/-/g, ' ')
      : '';
  } catch (e) {}
  var cv = await drawShelfieCard(dataUrl, meta);
  if (!cv) { toast('Image export isn’t supported on this device'); return; }
  shareCanvasFile(cv, 'my-cozy-shelfie.png', 'My Cozy Shelfie');
  if (typeof track === 'function') track('shelfie_shared', { books: meta.books || 0 });
}
