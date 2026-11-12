// Shape pins for v652, the edition_images contributor-policy fix
// and edition_assets sub-score ranges for #364 (the insert policy
// was WITH CHECK true — verified and uploaded_by self-asserted —
// while update/delete keyed ownership on that same assertion; and
// of the eight edition_assets scores only quality_score had a
// range).
//
// No live Postgres in this suite's world: the migration's safety
// is pinned as posture, like rls-hardening.test.js pins v636 —
// the insert pins the caller and unverified arrival, the update
// can neither touch nor produce a verified row, the delete policy
// and the admin write policy are NOT churned, and each of the
// seven sub-scores gets quality_score's exact 0–100 NULL-tolerant
// shape under its own name.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v652_edition_images_contributor_policies.sql');
ok('v652 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

/* ---------- arm 1: edition_images policies ---------- */
ok('the WITH CHECK true insert policy is dropped',
  /drop policy if exists "edition_images authenticated insert" on public\.edition_images;/.test(sql));
ok('contributor insert pins uploaded_by to the caller',
  /create policy "edition_images contributor insert"[\s\S]*?with check \(uploaded_by = auth\.uid\(\) and verified = false\);/.test(sql));
ok('contributor insert demands unverified arrival',
  /create policy "edition_images contributor insert"[\s\S]*?for insert[\s\S]*?verified = false/.test(sql));
ok('contributor update can only see own unverified rows',
  /create policy "edition_images contributor update"[\s\S]*?using \(uploaded_by = auth\.uid\(\) and not verified\)/.test(sql));
ok('contributor update can never produce a verified row',
  /create policy "edition_images contributor update"[\s\S]*?with check \(uploaded_by = auth\.uid\(\) and verified = false\);/.test(sql));
ok('the delete policy is NOT churned (its qual becomes sound via the insert pin)',
  !/drop policy if exists "edition_images contributor delete"/.test(sql) &&
  !/create policy "edition_images contributor delete"/.test(sql));
ok('the admin write policy is NOT touched (js/165 rides it)',
  !/"edition_images admin write"/.test(sql));
ok('no WITH CHECK true survives anywhere in the file',
  !/with check \(true\)/.test(sql));

/* ---------- arm 2: edition_assets sub-score ranges ---------- */
const subs = ['sharpness', 'exposure', 'perspective', 'coverage', 'glare', 'resolution', 'stability'];
for (const s of subs) {
  ok(`${s}_score gets quality_score's 0-100 NULL-tolerant check`,
    new RegExp(`add constraint edition_assets_${s}_score_check\\s+check \\(${s}_score is null or \\(${s}_score >= 0 and ${s}_score <= 100\\)\\);`).test(sql));
}
ok('quality_score itself is not re-constrained (its check already exists)',
  !/edition_assets_quality_score_check/.test(sql));
ok('exactly seven constraints are added',
  (sql.match(/add constraint edition_assets_/g) || []).length === 7);
ok('no existing data is touched',
  !/update public\.edition_|delete from public\.edition_|insert into public\.edition_/.test(sql));

console.log(`\nedition-images-policies: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
