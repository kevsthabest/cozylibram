#!/usr/bin/env node
/* Generates the seed INSERT for supabase/tropes.sql from js/156-trope-taxonomy.js.
   Run: node supabase/gen-trope-seed.js  →  paste output between the
   BEGIN/END GENERATED SEED markers in supabase/tropes.sql.
   Re-run on every taxonomy bump (TROPE_TAXONOMY_VERSION change).
   v157 note: the JS file is the initial seed + offline fallback. Trope Lab
   approvals now go straight to the live `tropes` table (one tap, no file
   edit), so this script only needs re-running when the bundled file itself
   changes. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(APP_DIR, 'js', '156-trope-taxonomy.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.OUT = { v: TROPE_TAXONOMY_VERSION, tropes: TROPES, aliases: TROPE_ALIASES, exclusions: TROPE_EXCLUSIONS };', sandbox);
const { v, tropes, aliases, exclusions } = sandbox.OUT;

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const qa = a => 'ARRAY[' + (a || []).map(q).join(', ') + ']';
const lines = tropes.map(t =>
  `  (${q(t.id)}, ${q(t.name)}, ${q(t.description)}, ` +
  `ARRAY[${t.genres.map(q).join(', ')}], ${v}, ` +
  `${qa(aliases[t.id])}, ${qa(exclusions[t.id])})`
);
console.log(`-- BEGIN GENERATED SEED (from js/156-trope-taxonomy.js v${v}, ${tropes.length} tropes)`);
console.log('-- Regenerate with: node supabase/gen-trope-seed.js');
console.log('insert into tropes (id, name, description, genres, version, aliases, exclusions)');
console.log('values');
console.log(lines.join(',\n'));
console.log('on conflict (id) do update set');
console.log('  name = excluded.name,');
console.log('  description = excluded.description,');
console.log('  genres = excluded.genres,');
console.log('  version = excluded.version,');
console.log('  aliases = excluded.aliases,');
console.log('  exclusions = excluded.exclusions;');
console.log(`-- END GENERATED SEED`);
