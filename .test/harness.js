// Shared test harness: loads the app's js/*.js files (in numeric load
// order, same as index.html) into a JSDOM window as classic scripts.
//
// Converted files are real ES modules, so their bodies pass through a
// marker-stripping transform before injection (classicize, below); a file
// carrying first-party static imports goes through the module loader
// (loadJsFile, further down), which resolves and loads its dependencies
// first through this same pipeline.
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';
const JS_DIR = path.join(APP_DIR, 'js');

function jsFiles() {
  return fs.readdirSync(JS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(JS_DIR, f));
}

// jsdom doesn't provide requestAnimationFrame; the app uses it for
// animations. Polyfill with setTimeout so tests don't crash.
function ensureAnimationFrame(window) {
  if (typeof window.requestAnimationFrame === 'undefined') {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }
}

function injectScript(window, text) {
  const el = window.document.createElement('script');
  el.textContent = text;
  window.document.body.appendChild(el);
}

function loadApp(window) {
  ensureAnimationFrame(window);
  for (const file of jsFiles()) {
    loadJsFile(window, file);
  }
}

// --- ES-module support: classicize (plan §9.2) and the loader (§9.4) -------
// jsdom cannot execute module scripts, so a converted file (a real ES
// module: named exports only) is loaded by stripping its module markers
// and injecting the identical body as a classic script; the file's own
// bridge block then publishes its surface on the window exactly as in
// production.
//
// classicize() is that marker-stripping transform, and it is deliberately
// all a direct caller gets: it THROWS on any static import or re-export.
// A silently stripped import would leave the body referencing names
// nobody loaded, so the failure is loud and names the file. Suites that
// evaluate files directly (the vm-loader suites) keep this tripwire until
// the PR that wires one of their files moves that call site to the
// module loader below — a deliberate, disclosed step, never a silent
// change of meaning.
//
// The module loader (loadJsFile) is the sanctioned path for a file that
// carries first-party static imports. The strictness classicize enforced
// by refusal is enforced there by checks instead — see the loader section.
const RE_STATIC_IMPORT = /^[ \t]*import[ \t]+(?:\{|\*|[A-Za-z_$'"])/m;
const RE_REEXPORT = /^[ \t]*export[ \t]*(?:\{[^}]*\}|\*)[ \t]*from[ \t]*['"]/m;
const RE_EXPORT_DEFAULT = /^[ \t]*export[ \t]+default\b/m;
const RE_EXPORT_LIST = /^[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*$/gm;
const RE_EXPORT_DECL = /^([ \t]*)export[ \t]+(?=(?:async[ \t]+)?function\b|class\b|const\b|let\b|var\b)/gm;

function stripExports(src, name, tool) {
  if (RE_EXPORT_DEFAULT.test(src)) {
    throw new Error(tool + ': ' + name + ' uses export default — the migration recipe is named exports only');
  }
  if (!/^[ \t]*export[ \t]/m.test(src)) return src; // classic file: identity
  return src.replace(RE_EXPORT_LIST, '').replace(RE_EXPORT_DECL, '$1');
}

function classicize(src, filename) {
  const name = filename || '(unknown file)';
  if (RE_STATIC_IMPORT.test(src) || RE_REEXPORT.test(src)) {
    throw new Error('classicize: ' + name + ' carries a static import/re-export — ' +
      'classicize strips markers only and cannot bind imports; load the file through ' +
      'the harness module loader (loadJsFile / loadApp, plan §9.4) instead');
  }
  return stripExports(src, name, 'classicize');
}

// --- The module loader (plan §9.4) -----------------------------------------
// loadJsFile(window, file, rootDir) loads one file and, before it, every
// file it imports. rootDir bounds resolution (js/ for the app); it exists
// so the loader's own fixtures can exercise the machinery inside their
// own directory. What a load does, in order:
//
// 1. Parse the file's static imports. Only first-party relative
//    specifiers ('./name.js', resolving inside the load root) are
//    supported, because those are the only imports the wiring recipe can
//    produce. Anything else is a loud throw, in the tripwire's spirit:
//    a bare specifier, an absolute path, a URL, a specifier that escapes
//    the root, one naming no real file, an import form this parser does
//    not recognise, and any re-export.
// 2. Load each dependency first, recursively, through this same
//    function — so a dependency's body (and its bridge block) has run
//    before the importer's body executes, whatever the numeric file
//    order says. A cycle in the graph throws, naming the cycle: the tree
//    already has a known consumer-graph cycle (js/README's 020⇄040⇄041
//    note), and a loader that hung or bound undefined on one would hide
//    exactly the wiring mistake the cycle represents.
// 3. Validate every imported name against the dependency's exports,
//    parsed from its source. Importing a name the dependency does not
//    export throws, naming both files — production would fail the same
//    way, and a harness that bound undefined instead would let broken
//    wiring pass its suites.
// 4. Inject the importer's body with its import statements removed
//    (blanked, so line numbers survive) and its export markers stripped.
//    Plain imported names need no binding code: the dependency's
//    classicized body and bridge block publish its surface into the
//    window's shared global scope, which is where the importer's free
//    references resolve — the same mechanism the whole bridge design
//    already relies on. Accessor-published names (ADR-003) stay live
//    through it, because the window accessor forwards to the
//    dependency's own binding rather than copying a value.
//    Two shapes do need a prologue, prepended to the same script: an
//    aliased import (import { a as b }) becomes a window accessor
//    forwarding reads and writes to the real name, and a namespace
//    import (import * as ns) becomes a frozen object whose properties
//    are getters over the real names — both live, neither a snapshot.
//
// Each window gets its own loaded-file registry, so a file is injected at
// most once per window; loadApp simply walks js/ in directory order and
// lets dependency order pull files earlier when an import demands it.
const RE_IMPORT_FROM = /^[ \t]*import[ \t]+(\{[^{}]*\}|\*[ \t]+as[ \t]+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:[ \t]*,[ \t]*\{[^{}]*\})?)\s*from[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*(?:\/\/[^\n]*)?$/gm;
const RE_IMPORT_SIDE_EFFECT = /^[ \t]*import[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*(?:\/\/[^\n]*)?$/gm;
const RE_EXPORT_FUNC = /^[ \t]*export[ \t]+(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)/gm;
const RE_EXPORT_CLASS = /^[ \t]*export[ \t]+class[ \t]+([A-Za-z_$][\w$]*)/gm;
const RE_EXPORT_VAR_STMT = /^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([^;]*);/gm;
const RE_EXPORT_LIST_PARSE = /^[ \t]*export[ \t]*\{([^{}]*)\}[ \t]*;?[ \t]*$/gm;

function parseNamedList(text, name, spec) {
  const out = [];
  for (const part of text.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^([A-Za-z_$][\w$]*)(?:[ \t]+as[ \t]+([A-Za-z_$][\w$]*))?$/.exec(t);
    if (!m) {
      throw new Error('module loader: ' + name + ' has an import entry this loader cannot parse ("' +
        t + '" in the import from \'' + spec + '\')');
    }
    out.push({ imported: m[1], local: m[2] || m[1] });
  }
  return out;
}

// Splits a file's static imports out of its source. Returns the import
// records (in source order) and the source with each import statement
// blanked — blanked rather than deleted, so the body's line numbers (and
// therefore its error messages) still match the file on disk.
function extractImports(src, name) {
  const imports = [];
  const blank = (stmt) => stmt.replace(/[^\n]/g, '');
  let stripped = src.replace(RE_IMPORT_FROM, (stmt, clause, spec) => {
    const imp = { spec, bindings: [], namespace: null };
    const c = clause.trim();
    if (c.startsWith('{')) {
      imp.bindings = parseNamedList(c.slice(1, -1), name, spec);
    } else if (c.startsWith('*')) {
      imp.namespace = /\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)/.exec(c)[1];
    } else {
      const comma = c.indexOf(',');
      const def = (comma === -1 ? c : c.slice(0, comma)).trim();
      imp.bindings.push({ imported: 'default', local: def });
      if (comma !== -1) {
        const rest = c.slice(comma + 1).trim();
        if (!rest.startsWith('{')) {
          throw new Error('module loader: ' + name + ' has an import form this loader cannot parse (from \'' + spec + '\')');
        }
        imp.bindings.push(...parseNamedList(rest.slice(1, -1), name, spec));
      }
    }
    imports.push(imp);
    return blank(stmt);
  });
  stripped = stripped.replace(RE_IMPORT_SIDE_EFFECT, (stmt, spec) => {
    imports.push({ spec, bindings: [], namespace: null, sideEffect: true });
    return blank(stmt);
  });
  if (RE_STATIC_IMPORT.test(stripped)) {
    throw new Error('module loader: ' + name + ' carries an import form this loader does not recognise — ' +
      'refusing to strip what it cannot bind');
  }
  return { imports, stripped };
}

function resolveSpecifier(spec, importerFile, rootDir, importerName) {
  const shown = '\'' + spec + '\' (imported by ' + importerName + ')';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec) || spec.startsWith('//')) {
    throw new Error('module loader: URL specifier ' + shown + ' — only first-party relative imports are loadable');
  }
  if (spec.startsWith('/')) {
    throw new Error('module loader: absolute-path specifier ' + shown + ' — only first-party relative imports are loadable');
  }
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new Error('module loader: bare specifier ' + shown + ' — only first-party relative imports (\'./name.js\') are loadable');
  }
  if (!spec.endsWith('.js')) {
    throw new Error('module loader: specifier ' + shown + ' does not name a .js file');
  }
  const resolved = path.resolve(path.dirname(importerFile), spec);
  if (!resolved.startsWith(rootDir + path.sep)) {
    throw new Error('module loader: specifier ' + shown + ' resolves outside the load root (' + rootDir + ')');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('module loader: cannot resolve specifier ' + shown + ' — no such file');
  }
  return fs.realpathSync(resolved);
}

// Splits a declaration body on top-level commas and takes each segment's
// leading identifier (export let a = 0, b = false; exports two names).
// Initializers can nest brackets and strings — an object literal, a call —
// so depth and quoting are tracked. A name missed here surfaces later as
// a loud "does not export" throw, never a silent pass.
function declaratorNames(text) {
  const names = [];
  let depth = 0, quote = null, seg = '';
  const flush = () => {
    const m = /^[ \t]*([A-Za-z_$][\w$]*)/.exec(seg);
    if (m) names.push(m[1]);
    seg = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      seg += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; seg += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { flush(); continue; }
    seg += ch;
  }
  flush();
  return names;
}

// The names a file exports, parsed from its source: export declarations
// (function / class / const / let / var, including multi-declarator
// statements) plus export lists, where `export { a as b }` exports b.
function moduleExports(src) {
  const names = new Set();
  for (const m of src.matchAll(RE_EXPORT_FUNC)) names.add(m[1]);
  for (const m of src.matchAll(RE_EXPORT_CLASS)) names.add(m[1]);
  for (const m of src.matchAll(RE_EXPORT_VAR_STMT)) {
    for (const n of declaratorNames(m[1])) names.add(n);
  }
  for (const m of src.matchAll(RE_EXPORT_LIST_PARSE)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const am = /^([A-Za-z_$][\w$]*)(?:[ \t]+as[ \t]+([A-Za-z_$][\w$]*))?$/.exec(t);
      if (am) names.add(am[2] || am[1]);
    }
  }
  return names;
}

// Binding code for the two import shapes a shared global scope cannot
// resolve on its own. Aliases and namespace properties are getters (and,
// for aliases, a setter) over the real names, so they forward live to
// the dependency's bindings — value exports, function exports, and
// accessor-published exports alike — instead of copying load-time values.
function buildPrologue(imports, exportsOf) {
  const lines = [];
  for (const imp of imports) {
    if (imp.namespace) {
      lines.push('const ' + imp.namespace + ' = {};');
      for (const exported of exportsOf.get(imp)) {
        lines.push('Object.defineProperty(' + imp.namespace + ', ' + JSON.stringify(exported) +
          ', { enumerable: true, get: function () { return ' + exported + '; } });');
      }
      lines.push('Object.freeze(' + imp.namespace + ');');
    }
    for (const b of imp.bindings) {
      if (b.local === b.imported) continue;
      lines.push('Object.defineProperty(window, ' + JSON.stringify(b.local) +
        ', { configurable: true, enumerable: true, get: function () { return ' + b.imported +
        '; }, set: function (v) { ' + b.imported + ' = v; } });');
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

// Splits a leading 'use strict' directive off a body. A wired file may
// carry one as its first statement; the loader's prologue is prepended to
// the same script, which would demote the directive to a plain string
// expression and silently un-strict the body — so it is hoisted above
// the prologue instead. Leading blank lines and comments stay in place.
function splitUseStrict(body) {
  let i = 0;
  for (;;) {
    const rest = body.slice(i);
    const m = /^[ \t]*\n/.exec(rest) || /^[ \t]*\/\/[^\n]*\n/.exec(rest) || /^[ \t]*\/\*[\s\S]*?\*\//.exec(rest);
    if (!m) break;
    i += m[0].length;
  }
  const m = /^('use strict'|"use strict");/.exec(body.slice(i));
  if (!m) return ['', body];
  return [m[1] + ';\n', body.slice(0, i) + body.slice(i + m[0].length)];
}

const loadedFilesByWindow = new WeakMap();

function loadJsFile(window, file, rootDir) {
  ensureAnimationFrame(window);
  const root = fs.realpathSync(rootDir || JS_DIR);
  loadFileInto(window, fs.realpathSync(file), root, []);
}

function loadFileInto(window, file, rootDir, stack) {
  let loaded = loadedFilesByWindow.get(window);
  if (!loaded) { loaded = new Map(); loadedFilesByWindow.set(window, loaded); }
  if (loaded.has(file)) return loaded.get(file);
  const name = path.basename(file);
  const cycleAt = stack.indexOf(file);
  if (cycleAt !== -1) {
    const cycle = stack.slice(cycleAt).concat(file).map((f) => path.basename(f)).join(' -> ');
    throw new Error('module loader: import cycle detected: ' + cycle +
      ' — a cycle has no dependency order; refusing to load');
  }
  const src = fs.readFileSync(file, 'utf8');
  if (RE_REEXPORT.test(src)) {
    throw new Error('module loader: ' + name + ' carries a re-export (export ... from) — ' +
      'the recipe is named exports plus direct imports only');
  }
  const { imports, stripped } = extractImports(src, name);
  const record = { exports: moduleExports(src) };
  const exportsOf = new Map();
  stack.push(file);
  try {
    for (const imp of imports) {
      const depFile = resolveSpecifier(imp.spec, file, rootDir, name);
      const dep = loadFileInto(window, depFile, rootDir, stack);
      for (const b of imp.bindings) {
        if (b.imported === 'default') {
          throw new Error('module loader: ' + name + ' imports a default binding from \'' + imp.spec +
            '\' — the recipe is named exports only, and ' + path.basename(depFile) + ' has no default export');
        }
        if (!dep.exports.has(b.imported)) {
          throw new Error('module loader: ' + name + ' imports { ' + b.imported + ' } from \'' + imp.spec +
            '\', but ' + path.basename(depFile) + ' does not export that name');
        }
      }
      exportsOf.set(imp, dep.exports);
    }
  } finally {
    stack.pop();
  }
  const prologue = buildPrologue(imports, exportsOf);
  const body = stripExports(stripped, name, 'module loader');
  let text = body;
  if (prologue) {
    const parts = splitUseStrict(body);
    text = parts[0] + prologue + parts[1];
  }
  injectScript(window, text);
  loaded.set(file, record);
  return record;
}

module.exports = { loadApp, loadJsFile, jsFiles, APP_DIR, chainableSelect, classicize };

// Minimal PostgREST-style select builder for Supabase fakes: chainable
// .eq() filters, thenable so a bare `await select()` also resolves.
// `rows` are the full stored records; `project` maps one to the shape the
// real column projection would return (filter-only columns stay out).
function chainableSelect(rows, project) {
  const builder = {
    _rows: rows.slice(),
    eq(col, val) { this._rows = this._rows.filter(r => r[col] === val); return this; },
    then(resolve, reject) {
      return Promise.resolve({ data: this._rows.map(project), error: null }).then(resolve, reject);
    },
  };
  return builder;
}
