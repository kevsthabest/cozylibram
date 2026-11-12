// Shape pins for v650, the storage bucket size/MIME limits for
// #371 (all four buckets shipped with file_size_limit and
// allowed_mime_types NULL, so any writer could upload any size of
// any type into buckets the app serves publicly).
//
// There is no live Postgres in this suite's world, so the
// migration's safety is pinned as posture, exactly like
// rls-hardening.test.js pins v636: the four ruled bucket configs
// are present verbatim, no other bucket is touched, and the file
// writes no objects and changes no storage policy. Behaviour
// against the real buckets is verified post-apply by re-reading
// storage.buckets (see the migration header for the census the
// limits were set from).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v650_storage_bucket_limits.sql');
ok('v650 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

/* ---------- the four ruled bucket configs ---------- */
ok('covers: 2 MiB, WebP only (the js/136 transcoder contract)',
  /update storage\.buckets\s+set file_size_limit = 2097152,\s+allowed_mime_types = array\['image\/webp'\]\s+where id = 'covers';/.test(sql));
ok('edition-images: 5 MiB, JPEG only (every capture writer is JPEG)',
  /update storage\.buckets\s+set file_size_limit = 5242880,\s+allowed_mime_types = array\['image\/jpeg'\]\s+where id = 'edition-images';/.test(sql));
ok('spine-photos: 5 MiB, JPEG only (legacy bucket, same posture)',
  /update storage\.buckets\s+set file_size_limit = 5242880,\s+allowed_mime_types = array\['image\/jpeg'\]\s+where id = 'spine-photos';/.test(sql));
ok('avatars: 1 MiB, JPEG only (the js/105 writer is a 256px JPEG render)',
  /update storage\.buckets\s+set file_size_limit = 1048576,\s+allowed_mime_types = array\['image\/jpeg'\]\s+where id = 'avatars';/.test(sql));

/* ---------- scope: exactly these buckets, nothing else ---------- */
ok('exactly four bucket updates',
  (sql.match(/update storage\.buckets/g) || []).length === 4);
ok('no object is written, moved, or deleted',
  !/insert into storage\.objects|delete from storage\.objects|update storage\.objects/.test(sql));
ok('no storage policy is created, altered, or dropped',
  !/policy/i.test(sql));
ok('no speculative MIME types sneak in (no png/heic/pdf anywhere)',
  !/image\/png|image\/heic|application\/pdf/.test(sql));

console.log(`\nstorage-bucket-limits: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
