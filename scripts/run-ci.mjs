// run-ci.mjs — the CI runner for the Cozy Libram test suite.
//
// What this proves, and why it is shaped this way:
//
// 1. The suite, run the way the baseline was measured. CONSTRAINTS.md's
//    named baseline (ADR-012) was measured SERIALLY — under parallel
//    load, heavy suites (cover-adoption-closure, import, orbitcapture)
//    fail on timeouts and pass serially. So this runner executes every
//    .test/*.test.js standalone with node, one at a time, in sorted
//    order. Parallelizing it would manufacture failures the baseline
//    never recorded and make the comparison below meaningless.
//
// 2. The failing set EQUALS the baseline — in both directions. A new
//    failure fails the job (that is the point of a gate). A baseline
//    file starting to pass ALSO fails the job: the baseline moves only
//    by a named decision that updates CONSTRAINTS.md and
//    .test/baseline-failures.txt together (CONSTRAINTS.md rule 4), so a
//    silently shrinking failing set means the record and the tree have
//    drifted apart, and someone should say so out loud.
//
// 3. The version pair is consistent, and moved when it had to.
//    APP_VERSION (js/181-appversion.js) and the CACHE name in sw.js
//    must agree (CONSTRAINTS.md rule 2). And when a change touches
//    served app code, the pair must DIFFER from the base's pair —
//    numbers are allocated as base+1 at rebase time and compose in
//    merge order (docs/runbook.md §2), so this check never demands a
//    specific number, only that the pair moved. Docs-only and
//    test-only changes never bump and are exempt from the "moved" half.
//
// Suites are run with COZYLIBRAM_DIR pointed at this checkout
// (CONSTRAINTS.md rule 1): run against any other tree, the result
// would prove nothing about this change.
//
// Invocation: `node scripts/run-ci.mjs` from anywhere; the repo root is
// derived from this file's location (or COZY_ROOT if set). The base
// commit for check 3 comes from CI_BASE_SHA (the workflow sets it from
// the PR base / the push's before-SHA); without a usable base, check
// 3's "moved" half is skipped with a note and check 3's pairing half
// still runs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.COZY_ROOT
  ? path.resolve(process.env.COZY_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- "Served app code", for the version-moved check -------------------
// The set a stale service worker could keep serving if the CACHE name
// did not move: everything the Pages deploy serves as the app. Anything
// outside this set (docs/, .test/, scripts/, supabase/, specs/, root
// Markdown, server.py, .github/) cannot be served stale and never
// forces a bump on its own.
const APP_CODE_PREFIXES = ['js/', 'assets/', 'img/', 'vendor/', 'functions/'];
const APP_CODE_FILES = new Set([
  'index.html',
  'sw.js',
  'styles.css',
  'manifest.json',
  '_headers',
  'icon-512.png',
  'icon-maskable-512.png',
  'icon-maskable.svg',
  'icon.svg',
]);

export function isAppCode(repoPath) {
  const p = repoPath.split(path.sep).join('/');
  return APP_CODE_FILES.has(p) || APP_CODE_PREFIXES.some((pre) => p.startsWith(pre));
}

// --- Version pair ------------------------------------------------------

export function parseAppVersion(text) {
  const m = /APP_VERSION\s*=\s*'(v\d+)'/.exec(text || '');
  return m ? m[1] : null;
}

export function parseCacheVersion(text) {
  const m = /CACHE\s*=\s*'cozy-libram-(v\d+)'/.exec(text || '');
  return m ? m[1] : null;
}

// The pair as read from the two file texts: { app, cache }.
export function pairOf(appText, swText) {
  return { app: parseAppVersion(appText), cache: parseCacheVersion(swText) };
}

// --- Baseline comparison ----------------------------------------------

export function readBaseline(root) {
  const raw = fs.readFileSync(path.join(root, '.test', 'baseline-failures.txt'), 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .sort();
}

// failing and baseline are arrays of repo-relative suite paths.
// Returns { equal, newFailures, nowPassing }.
export function compareToBaseline(failing, baseline) {
  const failSet = new Set(failing);
  const baseSet = new Set(baseline);
  const newFailures = [...failSet].filter((f) => !baseSet.has(f)).sort();
  const nowPassing = [...baseSet].filter((f) => !failSet.has(f)).sort();
  return { equal: newFailures.length === 0 && nowPassing.length === 0, newFailures, nowPassing };
}

// --- git helpers --------------------------------------------------------

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function usableBaseSha(sha) {
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha) || /^0+$/.test(sha)) return null;
  return git(['cat-file', '-e', `${sha}^{commit}`]) !== null ? sha : null;
}

// --- Main ----------------------------------------------------------------

function main() {
  const problems = [];
  const notes = [];

  // 1 + 2: the suite, serially, against the baseline.
  const testDir = path.join(ROOT, '.test');
  const suites = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => `.test/${f}`);

  const baseline = readBaseline(ROOT);
  const failing = [];
  const failOutput = new Map();

  console.log(`Running ${suites.length} suites serially (COZYLIBRAM_DIR=${ROOT})…`);
  for (const rel of suites) {
    const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
      cwd: ROOT,
      env: { ...process.env, COZYLIBRAM_DIR: ROOT },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0) {
      console.log(`PASS ${rel}`);
    } else {
      failing.push(rel);
      failOutput.set(rel, `${r.stdout || ''}${r.stderr || ''}`);
      console.log(`FAIL ${rel} (exit ${r.status === null ? 'killed' : r.status})`);
    }
  }
  failing.sort();

  const cmp = compareToBaseline(failing, baseline);
  if (!cmp.equal) {
    if (cmp.newFailures.length) problems.push(`new failures not in the baseline: ${cmp.newFailures.join(', ')}`);
    if (cmp.nowPassing.length) {
      problems.push(
        `baseline files now passing (the baseline moves only by named decision — CONSTRAINTS.md rule 4): ${cmp.nowPassing.join(', ')}`,
      );
    }
  }

  // 3a: the version pair, internally consistent.
  const headPair = pairOf(
    fs.readFileSync(path.join(ROOT, 'js', '181-appversion.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'),
  );
  let versionPairLine;
  if (!headPair.app || !headPair.cache) {
    versionPairLine = `UNREADABLE (APP_VERSION=${headPair.app}, CACHE=${headPair.cache})`;
    problems.push(`could not parse the version pair (APP_VERSION=${headPair.app}, CACHE=${headPair.cache})`);
  } else if (headPair.app !== headPair.cache) {
    versionPairLine = `MISMATCH (APP_VERSION=${headPair.app} vs CACHE=cozy-libram-${headPair.cache})`;
    problems.push(`version pair mismatch: APP_VERSION=${headPair.app} but CACHE is cozy-libram-${headPair.cache}`);
  } else {
    versionPairLine = `OK (${headPair.app} = cozy-libram-${headPair.cache})`;
  }

  // 3b: served-code changes must move the pair off the base's pair.
  let versionMovedLine;
  const baseSha = usableBaseSha(process.env.CI_BASE_SHA);
  if (!baseSha) {
    versionMovedLine = 'SKIPPED (no usable CI_BASE_SHA — pairing check above still applies)';
    notes.push('version-moved check skipped: CI_BASE_SHA missing or not a commit in this checkout');
  } else {
    const changed = (git(['diff', '--name-only', baseSha, 'HEAD']) || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const appChanged = changed.filter((p) => isAppCode(p));
    if (appChanged.length === 0) {
      versionMovedLine = `NOT REQUIRED (no served app code changed vs base ${baseSha.slice(0, 7)})`;
    } else {
      const baseApp = git(['show', `${baseSha}:js/181-appversion.js`]);
      const baseSw = git(['show', `${baseSha}:sw.js`]);
      if (baseApp === null || baseSw === null) {
        versionMovedLine = 'SKIPPED (base pair unreadable at base commit)';
        notes.push('version-moved check skipped: js/181-appversion.js or sw.js not readable at the base commit');
      } else {
        const basePair = pairOf(baseApp, baseSw);
        if (basePair.app === headPair.app && basePair.cache === headPair.cache) {
          versionMovedLine = `FAIL (served app code changed but the pair is still ${headPair.app}, same as base)`;
          problems.push(
            `served app code changed (${appChanged.length} file(s), e.g. ${appChanged[0]}) but the version pair did not move off the base's ${basePair.app} — bump APP_VERSION + CACHE together (runbook §2)`,
          );
        } else {
          versionMovedLine = `OK (pair moved ${basePair.app} → ${headPair.app}; ${appChanged.length} served file(s) changed)`;
        }
      }
    }
  }

  // Summary — the log is the artefact a reader triages from.
  console.log('\n================ CI SUMMARY ================');
  console.log(`Suites run:        ${suites.length}`);
  console.log(`Passed:            ${suites.length - failing.length}`);
  console.log(`Failed:            ${failing.length}`);
  console.log(`Failing set:       ${failing.length ? failing.join(', ') : '(none)'}`);
  console.log(
    `Baseline status:   ${
      cmp.equal
        ? 'EQUAL — the failing set is exactly the named baseline'
        : `DIFFERS — new failures: [${cmp.newFailures.join(', ') || 'none'}]; baseline now passing: [${cmp.nowPassing.join(', ') || 'none'}]`
    }`,
  );
  console.log(`Version pair:      ${versionPairLine}`);
  console.log(`Version moved:     ${versionMovedLine}`);
  for (const n of notes) console.log(`Note:              ${n}`);
  console.log(`Verdict:           ${problems.length ? 'FAIL' : 'PASS'}`);
  console.log('============================================');

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '## CI summary',
      '',
      `- Suites: ${suites.length} run, ${suites.length - failing.length} passed, ${failing.length} failed`,
      `- Failing set: ${failing.length ? failing.map((f) => `\`${f}\``).join(', ') : '(none)'}`,
      `- Baseline: ${cmp.equal ? 'equal to `.test/baseline-failures.txt`' : '**differs** (see log)'}`,
      `- Version pair: ${versionPairLine}`,
      `- Version moved: ${versionMovedLine}`,
      `- Verdict: **${problems.length ? 'FAIL' : 'PASS'}**`,
      '',
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  if (problems.length) {
    console.log('\nProblems:');
    for (const p of problems) console.log(`- ${p}`);
  }

  // Failing suites' own output, tailed — the first thing a triage needs.
  for (const rel of failing) {
    const out = (failOutput.get(rel) || '').trimEnd().split(/\r?\n/);
    console.log(`\n----- output: ${rel} (last ${Math.min(60, out.length)} of ${out.length} lines) -----`);
    console.log(out.slice(-60).join('\n'));
  }

  process.exit(problems.length ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main();
