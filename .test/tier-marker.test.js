// Shape pins for v618, the cast-tier marker on book_characters
// (design: the curation console package's tier-control design).
//
// The migration's safety is its posture, so that is what gets
// pinned: two additive nullable columns, both vocabularies closed
// by CHECK constraints, no backfill (NULL is the pre-tier state and
// readers treat it as Tier 1 posture), and no policy or data
// statements of any kind — the existing book_characters RLS is
// meant to govern the new columns unchanged, and existing rows are
// meant to be byte-identical after the apply.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v618_book_characters_tier.sql');
ok('v618 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

ok('adds tier as smallint, guarded',
  /add column if not exists tier smallint/.test(sql));
ok('adds tier_source as text, guarded',
  /add column if not exists tier_source text/.test(sql));
ok('neither new column is NOT NULL or defaulted',
  !/add column if not exists (tier|tier_source)[^,;]*(not null|default)/.test(sql));

ok('tier range check closes the vocabulary at 1-3',
  /check \(tier is null or tier in \(1, 2, 3\)\)/.test(sql));
ok('tier_source check closes the vocabulary at computed/pushed/override',
  /check \(tier_source is null\s+or tier_source in \('computed', 'pushed', 'override'\)\)/.test(sql));
ok('both constraint adds are exception-guarded, so the migration is re-runnable',
  /do \$\$ begin\s+alter table public\.book_characters\s+add constraint book_characters_tier_range[\s\S]*?exception when duplicate_object then null;\s+end \$\$;/.test(sql) &&
  /do \$\$ begin\s+alter table public\.book_characters\s+add constraint book_characters_tier_source_vocab[\s\S]*?exception when duplicate_object then null;\s+end \$\$;/.test(sql));

ok('no backfill: no UPDATE against book_characters',
  !/update\s+public\.book_characters/.test(sql));
ok('no data statements at all (insert/delete/copy)',
  !/\b(insert into|delete from|copy)\b/.test(sql));
ok('no policy or RLS statements — existing policies govern unchanged',
  !/(create policy|alter policy|row level security)/.test(sql));
ok('no other table is touched',
  !/alter table\s+(?!public\.book_characters)/.test(sql));

console.log('\n' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
