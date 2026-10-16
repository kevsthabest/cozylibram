'use strict';

/* ---------------- Edition Assets (v286) ----------------
   The Observatory's Edition Assets tab, extracted into its
   own module (architecture candidate 6, final piece):
   edition-asset moderation — review candidate evidence,
   verify or reject captures, pin a canonical asset. The
   render path is renderEditionAssetLab(), dispatched from
   the Observatory shell in js/199-admin.js (adminTab ===
   'assets'). It reads the shell's isAppAdmin at runtime,
   as it did when it lived in js/199. Nothing else moves:
   the shell and the other tabs stay in js/199 (the Trope,
   Character, Analytics, Spine Lab and Logs tabs live in
   js/161–163, js/164 and js/166). Load order: after js/164
   and before js/199 (whose dispatch calls it at runtime);
   every cross-file reference is a runtime call through the
   shared global scope — this file declares only its own
   function at eval time. */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export async function renderEditionAssetLab() {
  const body = document.getElementById('ob-body');
  if (!body || !isAppAdmin) return;
  body.innerHTML =
    '<div class="ob-card"><h3 class="serif">Edition asset moderation</h3>' +
    '<p class="note">Review candidate evidence, verify good captures, reject bad ones, or pin an explicit canonical asset. Rejected candidates remain in the database for audit/history but never appear in the public API.</p>' +
    '<div class="spinelab-form">' +
    '<input id="eal-isbn" class="text-input" placeholder="ISBN" inputmode="numeric">' +
    '<select id="eal-face" class="text-input"><option value="">All faces</option><option value="spine">Spine</option><option value="front">Front</option><option value="back">Back</option><option value="fore_edge">Fore-edge</option><option value="top_edge">Top edge</option><option value="bottom_edge">Bottom edge</option></select>' +
    '<select id="eal-ap" class="text-input"><option value="">All appearances</option><option value="jacket">Jacket</option><option value="board">Board</option><option value="slipcase">Slipcase</option></select>' +
    '<button class="btn" id="eal-go">Load candidates</button></div></div>' +
    '<div id="eal-result"><p class="note">Enter an ISBN to review its candidates.</p></div>';

  const result = document.getElementById('eal-result');
  const load = async () => {
    const isbn = document.getElementById('eal-isbn').value.trim().replace(/[^0-9Xx]/g, '').toUpperCase();
    const face = document.getElementById('eal-face').value;
    const ap = document.getElementById('eal-ap').value;
    if (!isbn) { result.innerHTML = '<p class="note">Enter an ISBN first.</p>'; return; }
    result.innerHTML = '<p class="note">Loading…</p>';
    try {
      const sb = await cloudClient();
      const er = await sb.from('editions').select('id,isbn,publisher,format,page_count').eq('isbn', isbn).maybeSingle();
      if (er.error) throw er.error;
      if (!er.data) { result.innerHTML = '<p class="note">No edition row for ' + esc(isbn) + '.</p>'; return; }
      let q = sb.from('edition_assets')
        .select('id,face,appearance,bucket,path,width,height,quality_score,sharpness_score,exposure_score,perspective_score,coverage_score,glare_score,resolution_score,stability_score,verified,rejected,created_at')
        .eq('edition_id', er.data.id).order('quality_score', { ascending: false, nullsFirst: false }).limit(200);
      if (face) q = q.eq('face', face);
      if (ap) q = q.eq('appearance', ap);
      const ar = await q;
      if (ar.error) throw ar.error;
      const sr = await sb.from('edition_asset_slots').select('face,appearance,canonical_asset_id,selection_method,selected_at').eq('edition_id', er.data.id);
      const slotMap = {};
      (sr.data || []).forEach(s => { slotMap[s.appearance + ':' + s.face] = s; });
      const publicUrl = (a) => {
        try {
          return sb.storage.from(a.bucket || 'edition-images').getPublicUrl(a.path || '').data.publicUrl || '';
        } catch (e) { return ''; }
      };
      const cards = (ar.data || []).map(a => {
        const key = a.appearance + ':' + a.face, slot = slotMap[key];
        const canonical = slot && slot.canonical_asset_id === a.id;
        return '<div class="ob-card eal-card">' +
          '<div class="eal-media"><img src="' + esc(publicUrl(a)) + '" alt="' + esc(a.appearance + ' ' + a.face) + '" loading="lazy"></div>' +
          '<div class="eal-info"><h3>' + esc(a.appearance + ' · ' + a.face) + '</h3>' +
          '<p class="note">Quality <b>' + (a.quality_score == null ? '—' : Number(a.quality_score).toFixed(1)) + '</b> · ' +
          (a.verified ? 'verified' : a.rejected ? 'rejected' : 'unverified') +
          (canonical ? ' · <b>CANONICAL</b>' : '') + '</p>' +
          '<p class="note">Sharp ' + (a.sharpness_score == null ? '—' : Number(a.sharpness_score).toFixed(0)) +
          ' · Exposure ' + (a.exposure_score == null ? '—' : Number(a.exposure_score).toFixed(0)) +
          ' · Glare ' + (a.glare_score == null ? '—' : Number(a.glare_score).toFixed(0)) +
          ' · Resolution ' + (a.resolution_score == null ? '—' : Number(a.resolution_score).toFixed(0)) + '</p>' +
          '<p class="note">' + esc((a.width || '?') + '×' + (a.height || '?') + ' · ' + a.id) + '</p>' +
          '<div class="ob-ranges">' +
          '<button class="btn sm" data-eal-verify="' + esc(a.id) + '"' + (a.verified || a.rejected ? ' disabled' : '') + '>Verify</button>' +
          '<button class="btn sm ghost" data-eal-reject="' + esc(a.id) + '"' + (a.rejected ? ' disabled' : '') + '>Reject</button>' +
          '<button class="btn sm ghost" data-eal-canon="' + esc(a.id) + '"' + (canonical ? ' disabled' : '') + '>Set canonical</button>' +
          '</div></div></div>';
      }).join('');
      result.innerHTML = '<p class="note">' + (ar.data || []).length + ' candidate(s) for ' + esc(isbn) + '.</p>' +
        (cards || '<p class="note">No candidates.</p>');
      result.querySelectorAll('[data-eal-verify]').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true;
        await sb.from('edition_assets').update({ verified: true, rejected: false }).eq('id', btn.dataset.ealVerify);
        await load();
      }));
      result.querySelectorAll('[data-eal-reject]').forEach(btn => btn.addEventListener('click', async () => {
        if (!await confirmModal('Reject this candidate?', { okLabel: 'Reject' })) return;
        btn.disabled = true;
        await sb.from('edition_assets').update({ rejected: true, verified: false }).eq('id', btn.dataset.ealReject);
        await load();
      }));
      result.querySelectorAll('[data-eal-canon]').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true;
        const asset = (ar.data || []).find(a => a.id === btn.dataset.ealCanon);
        if (!asset) return;
        const uidr = await sb.auth.getUser(), uid = uidr && uidr.data && uidr.data.user && uidr.data.user.id;
        if (!uid) return;
        await sb.from('edition_asset_slots').upsert({
          edition_id: er.data.id, isbn: er.data.isbn, face: asset.face, appearance: asset.appearance,
          canonical_asset_id: asset.id, selection_method: 'admin', selected_by: uid,
          selected_at: new Date().toISOString(), updated_at: new Date().toISOString()
        }, { onConflict: 'edition_id,face,appearance' });
        await sb.from('edition_images').upsert({
          isbn: er.data.isbn, edition_id: er.data.id, face: asset.face, appearance: asset.appearance,
          bucket: asset.bucket, path: asset.path, uploaded_by: uid, verified: !!asset.verified,
          updated_at: new Date().toISOString()
        }, { onConflict: 'isbn,face,appearance' });
        await load();
      }));
    } catch (e) {
      result.innerHTML = '<p class="note">Could not load candidates: ' + esc((e && e.message) || e) + '</p>';
    }
  };
  document.getElementById('eal-go').addEventListener('click', load);
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The one classic consumer, js/199-admin.js, calls renderEditionAssetLab() at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.renderEditionAssetLab = renderEditionAssetLab;
