#!/usr/bin/env node
/* scripts/module-map.mjs — generate docs/module-map.md from the tree.
 *
 * The module map is a generated document (Repo Legibility Standard,
 * docs/repo-legibility-spec.md §5): a hand-maintained map rots the moment
 * a file is added, renamed, or re-surfaced, so every fact in the output
 * is derived from source here and nothing is hand-listed. If this script
 * ever needs a literal list of js files, that is a defect in the script,
 * not a shortcut.
 *
 * What is derived, per top-level js/*.js file:
 * - Load shape (module vs classic) from the file's <script> tag in
 *   index.html — the tag is what the browser obeys, so it is the only
 *   honest source for the shape.
 * - Static imports of sibling js files (`import ... from './NNN-*.js'`),
 *   with the imported names, read from the token stream. Imported-by is
 *   the same edges reversed. Dynamic import() calls are not static
 *   wiring and are ignored, as are imports of anything outside js/.
 * - Bridge publications: the distinct names the file publishes on
 *   window, counted by the ADR-013 method — tokenized, comment-stripped
 *   source; a value publication is a `window.NAME =` token sequence and
 *   an accessor publication is an `Object.defineProperty(window,
 *   'NAME', ...)` call, and the two kinds count separately. Occurrences
 *   are not publications: feature checks (`typeof window.X === ...`),
 *   comment text, and a second assignment of the same name in the same
 *   file add nothing.
 * - Purpose: the first sentence of the file's Layer-1 header, when the
 *   header names the file (`/* js/NNN-name.js — ...`). A file without
 *   that header shows a hole in the map on purpose (spec §3): the
 *   standard enforces itself by making the gap visible, and inventing a
 *   purpose here would hide exactly the gap the map exists to expose.
 * - Whether the file still carries the ES-modules migration boilerplate
 *   banner (the successor phase replaces that banner with a real header,
 *   so the column is the burn-down list for the banner).
 *
 * Determinism is a hard requirement, not a nicety: the freshness suite
 * (.test/module-map.test.js) byte-compares the committed map against a
 * fresh generation, so the same tree must always produce the same bytes.
 * Every list is sorted with the default code-unit ordering, counts are
 * plain integers, and the output carries no timestamps, no absolute
 * paths, and nothing read from the environment.
 *
 * Usage:
 *   node scripts/module-map.mjs [--root DIR] [--out FILE]
 * --root defaults to the repo root (this script's parent directory);
 * --out defaults to <root>/docs/module-map.md and exists so tests and
 * verification runs can generate into a scratch location without
 * dirtying the working tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNER_MARKER = '/* ES MODULE (ES-modules migration, bridge-everything pass):';

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/*                                                                     */
/* A small hand-rolled scanner — the generator must stay dependency-  */
/* free, and the census needs a token stream, not text matches: text  */
/* cannot tell a publication from a feature check, a comment, or a     */
/* string that merely mentions window. The scanner strips comments,    */
/* keeps string values (defineProperty names live in one), tokenizes  */
/* template-literal expressions as real code (they are), and tells a   */
/* regex literal from a division by the previous token — a `/` starts */
/* a regex only where an expression can start. That heuristic is the   */
/* one approximation in this file; it errs only on source shapes the   */
/* tree does not contain, and the ADR-013 census (1,836 value + 20     */
/* accessor) is the check that it has not erred here.                  */
/* ------------------------------------------------------------------ */

const REGEX_OK_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'case', 'do', 'else', 'yield', 'await', 'throw',
]);

function tokenize(src) {
  const toks = [];
  let prev = null;
  const push = (t, v) => {
    const tok = { t, v };
    toks.push(tok);
    prev = tok;
  };
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev.t === 'name') return REGEX_OK_KEYWORDS.has(prev.v);
    if (prev.t === 'num' || prev.t === 'str' || prev.t === 'regex' || prev.t === 'tpl') return false;
    if (prev.t === 'punct') return prev.v !== ')' && prev.v !== ']';
    return true;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { out += src[j + 1] ?? ''; j += 2; } else { out += src[j]; j++; }
      }
      push('str', out);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      /* Template literal: literal text is one tpl token; each ${ ... }
       * expression is tokenized as code, because a publication hidden
       * in an expression is still a publication. */
      let j = i + 1;
      push('tpl', '');
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            const ch = src[k];
            if (ch === '{') { depth++; k++; } else if (ch === '}') { depth--; k++; } else if (ch === "'" || ch === '"' || ch === '`') {
              const q = ch;
              k++;
              while (k < n && src[k] !== q) { if (src[k] === '\\') k++; k++; }
              k++;
            } else if (ch === '/' && src[k + 1] === '/') {
              while (k < n && src[k] !== '\n') k++;
            } else if (ch === '/' && src[k + 1] === '*') {
              const e = src.indexOf('*/', k + 2);
              k = e === -1 ? n : e + 2;
            } else k++;
          }
          for (const t of tokenize(src.slice(j + 2, k - 1))) push(t.t, t.v);
          push('tpl', '');
          j = k;
          continue;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\n') break;
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        let k = j + 1;
        while (k < n && /[a-z]/i.test(src[k])) k++;
        push('regex', src.slice(i, k));
        i = k;
        continue;
      }
      /* No closing slash on this line: it was a division after all. */
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      push('name', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(src[j])) j++;
      push('num', src.slice(i, j));
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (['===', '!==', '**=', '<<=', '>>=', '>>>', '...', '&&=', '||=', '??='].includes(three)) { push('punct', three); i += 3; continue; }
    if (['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '=>', '**', '<<', '>>', '?.', '??', '&=', '|=', '^='].includes(two)) { push('punct', two); i += 2; continue; }
    push('punct', c);
    i++;
  }
  return toks;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

/* Load shapes from index.html's script tags. A js file with no tag is
 * reported as such rather than guessed: the browser never loads it, and
 * the map saying so is the useful fact. */
function loadShapes(root) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const shapes = new Map();
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    const srcM = /src="js\/([^"]+)"/.exec(m[1]);
    if (!srcM) continue;
    shapes.set(srcM[1], /type="module"/.test(m[1]) ? 'module' : 'classic');
  }
  return shapes;
}

/* Static imports of sibling js files, from the token stream. Only a
 * top-level statement of the form `import ... from './NNN-*.js'` (or a
 * side-effect `import './NNN-*.js'`) counts; a dynamic import() call is
 * a punct `(` after `import`, never one of these shapes. Aliased names
 * are recorded as written (`orig as alias`) so the map shows the binding
 * the importing file actually uses. */
function staticImports(toks, fileSet) {
  const edges = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t !== 'name' || toks[k].v !== 'import') continue;
    const next = toks[k + 1];
    if (!next || next.v === '(' || next.v === '.') continue; // dynamic import / import.meta
    /* Find the `from '<path>'` (or the bare side-effect path) before the
     * statement ends at `;` or the next statement's `import`/`export`. */
    let names = [];
    let target = null;
    let j = k + 1;
    if (toks[j] && toks[j].t === 'str') {
      target = toks[j].v;
      j++;
    } else {
      const braceNames = [];
      let sawBrace = false;
      while (j < toks.length && toks[j].v !== ';') {
        const t = toks[j];
        if (t.v === '{') { sawBrace = true; j++; continue; }
        if (t.v === '}') { j++; continue; }
        if (t.t === 'name' && t.v === 'from') {
          if (toks[j + 1] && toks[j + 1].t === 'str') target = toks[j + 1].v;
          j += 2;
          break;
        }
        if (sawBrace && t.t === 'name') {
          if (toks[j + 1] && toks[j + 1].v === 'as' && toks[j + 2] && toks[j + 2].t === 'name') {
            braceNames.push(t.v + ' as ' + toks[j + 2].v);
            j += 3;
          } else {
            braceNames.push(t.v);
            j++;
          }
          continue;
        }
        j++;
      }
      names = braceNames;
    }
    if (target && target.startsWith('./') && target.endsWith('.js')) {
      const base = target.slice(2);
      if (fileSet.has(base)) edges.push({ target: base, names });
    }
    k = j;
  }
  return edges;
}

/* Bridge publications by the ADR-013 method: distinct names per file,
 * value and accessor counted separately. */
function bridgePublications(toks) {
  const value = new Set();
  const accessor = new Set();
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t !== 'name') continue;
    if (toks[k].v === 'window'
      && toks[k + 1] && toks[k + 1].v === '.'
      && toks[k + 2] && toks[k + 2].t === 'name'
      && toks[k + 3] && toks[k + 3].v === '=') {
      value.add(toks[k + 2].v);
    }
    if (toks[k].v === 'Object'
      && toks[k + 1] && toks[k + 1].v === '.'
      && toks[k + 2] && toks[k + 2].v === 'defineProperty'
      && toks[k + 3] && toks[k + 3].v === '('
      && toks[k + 4] && toks[k + 4].v === 'window'
      && toks[k + 5] && toks[k + 5].v === ','
      && toks[k + 6] && toks[k + 6].t === 'str') {
      accessor.add(toks[k + 6].v);
    }
  }
  return { value: [...value].sort(), accessor: [...accessor].sort() };
}

/* The purpose line: first sentence of the Layer-1 header that names the
 * file. Only the head of the file is searched (the header is the first
 * thing in it), and the comment's wrapped lines are joined before the
 * sentence is cut, because headers wrap mid-sentence. */
function purposeLine(src, file) {
  const head = src.slice(0, 6000);
  const marker = '/* js/' + file + ' — ';
  const at = head.indexOf(marker);
  if (at === -1) return null;
  const end = head.indexOf('*/', at);
  if (end === -1) return null;
  const text = head.slice(at + marker.length, end)
    .replace(/^\s*\*\s?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^.*?[.?](?=\s|$)/.exec(text);
  return m ? m[0] : text;
}

/* A table cell must never contain a raw pipe or a newline: either would
 * silently reshape the table the freshness test byte-compares. */
function cell(text) {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildMap(root) {
  const jsDir = path.join(root, 'js');
  const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();
  const fileSet = new Set(files);
  const shapes = loadShapes(root);

  const rows = [];
  const importedBy = new Map(files.map(f => [f, []]));
  for (const f of files) {
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    const toks = tokenize(src);
    const imports = staticImports(toks, fileSet);
    for (const e of imports) importedBy.get(e.target).push(f);
    rows.push({
      file: f,
      shape: shapes.get(f) || 'not in index.html',
      purpose: purposeLine(src, f),
      imports,
      pubs: bridgePublications(toks),
      banner: src.includes(BANNER_MARKER),
    });
  }

  const modules = rows.filter(r => r.shape === 'module').length;
  const classics = rows.filter(r => r.shape === 'classic').length;
  const classicFiles = rows.filter(r => r.shape === 'classic').map(r => r.file);
  const bridgeFiles = rows.filter(r => r.pubs.value.length + r.pubs.accessor.length > 0).length;
  const totalValue = rows.reduce((s, r) => s + r.pubs.value.length, 0);
  const totalAccessor = rows.reduce((s, r) => s + r.pubs.accessor.length, 0);
  const totalEdges = rows.reduce((s, r) => s + r.imports.length, 0);
  const bannerFiles = rows.filter(r => r.banner).length;

  const out = [];
  out.push('<!-- GENERATED by scripts/module-map.mjs — do not edit; regenerate. -->');
  out.push('# Module map');
  out.push('');
  out.push('Generated by `scripts/module-map.mjs` from the tree — do not edit by hand.');
  out.push('Regenerate with:');
  out.push('');
  out.push('    node scripts/module-map.mjs');
  out.push('');
  out.push('Every fact below is derived from source: load shape from the `index.html`');
  out.push('script tags, static imports from the files themselves, bridge publications');
  out.push('counted by the ADR-013 method (distinct names in tokenized,');
  out.push('comment-stripped source; value and accessor publications counted');
  out.push('separately), and the purpose line lifted from each file\'s header.');
  out.push('A file whose header does not name it shows `—` for purpose: the hole is');
  out.push('the signal that the header is missing, not a gap to fill in here.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Measure | Count |');
  out.push('|---|---:|');
  out.push('| Files (`js/*.js`) | ' + rows.length + ' |');
  out.push('| Modules | ' + modules + ' |');
  out.push('| Classics | ' + classics + ' |');
  out.push('| Files with bridge publications | ' + bridgeFiles + ' |');
  out.push('| Bridge publications (distinct) | ' + (totalValue + totalAccessor) + ' |');
  out.push('| — value-published | ' + totalValue + ' |');
  out.push('| — accessor-published | ' + totalAccessor + ' |');
  out.push('| Wired import edges | ' + totalEdges + ' |');
  out.push('| Files still carrying the migration banner | ' + bannerFiles + ' |');
  out.push('');
  out.push('Classic files (the phase-4 knot): ' + classicFiles.map(f => '`js/' + f + '`').join(', ') + '.');
  out.push('');
  out.push('## Files');
  out.push('');
  out.push('| File | Load shape | Purpose | Imports | Imported by | Bridge publications | Migration banner |');
  out.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const purpose = r.purpose ? cell(r.purpose) : '—';
    const imports = r.imports.length
      ? r.imports.map(e => '`' + e.target + '`' + (e.names.length ? ': ' + e.names.join(', ') : '')).join('; ')
      : '—';
    const importers = importedBy.get(r.file);
    const importedByCell = importers.length ? importers.map(f => '`' + f + '`').join(', ') : '—';
    const total = r.pubs.value.length + r.pubs.accessor.length;
    let pubsCell = '0';
    if (total > 0) {
      const names = [
        ...r.pubs.value.map(nm => ({ nm, acc: false })),
        ...r.pubs.accessor.map(nm => ({ nm, acc: true })),
      ].sort((a, b) => (a.nm < b.nm ? -1 : a.nm > b.nm ? 1 : 0));
      pubsCell = total + ' (' + r.pubs.value.length + ' value, ' + r.pubs.accessor.length + ' accessor): '
        + names.map(x => x.acc ? x.nm + ' (accessor)' : x.nm).join(', ');
    }
    out.push('| `js/' + r.file + '` | ' + r.shape + ' | ' + purpose + ' | ' + cell(imports) + ' | ' + importedByCell + ' | ' + cell(pubsCell) + ' | ' + (r.banner ? 'yes' : 'no') + ' |');
  }
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let out = null;
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--root') root = path.resolve(argv[++k]);
    else if (argv[k] === '--out') out = path.resolve(argv[++k]);
    else { console.error('unknown argument: ' + argv[k]); process.exit(2); }
  }
  if (!out) out = path.join(root, 'docs', 'module-map.md');
  const map = buildMap(root);
  fs.writeFileSync(out, map);
  const summary = /\| Files \(`js\/\*\.js`\) \| (\d+) \|/.exec(map);
  console.log('module-map: wrote ' + path.relative(process.cwd(), out) + ' for ' + (summary ? summary[1] : '?') + ' js files');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

export { buildMap, tokenize };
