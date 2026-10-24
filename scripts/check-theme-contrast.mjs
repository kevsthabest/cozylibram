#!/usr/bin/env node
// Theme token contrast gate (Tuned adoption spec §5).
//
// The app's text colors come from three tokens per theme — --ink (body
// text), --muted (secondary text) and --faint (tertiary text, small
// print). If any of them falls under WCAG AA's 4.5:1 against the
// surfaces it renders on, that theme ships unreadable text no matter
// how carefully components are written, so the check lives on the
// tokens themselves rather than on rendered pages.
//
// For every theme block in styles.css this parses the six surface/text
// tokens, overlays the theme on the base (:root) block the way the
// cascade does, and computes the WCAG relative-luminance contrast of
// --ink, --muted and --faint against --card, --card2 and --bg.
// Any pair under 4.5:1 is reported with its theme, pair and ratio and
// the process exits 1. Zero-dependency on purpose: this runs as a leg
// of scripts/run-ci.mjs on any machine the suite runs on.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cssPath = join(root, 'styles.css');
const css = readFileSync(cssPath, 'utf8');

// Token comments inside the theme blocks quote hex values (for example
// a note recording the color a token replaced), so comments must go
// before anything is parsed or a quoted value can be mistaken for the
// token's own value.
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS = ['--bg', '--card', '--card2', '--ink', '--muted', '--faint'];
const TEXT_TOKENS = ['--ink', '--muted', '--faint'];
const SURFACES = ['--card', '--card2', '--bg'];
const FLOOR = 4.5;

// Extract the { ... } body following a selector, honoring nested braces
// so a media query wrapping theme blocks cannot truncate a block early.
function blockBodyAfter(src, fromIdx) {
  const open = src.indexOf('{', fromIdx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function parseTokens(body) {
  const out = {};
  if (!body) return out;
  for (const tok of TOKENS) {
    const m = body.match(new RegExp(tok + '\\s*:\\s*(#[0-9a-fA-F]{6})\\b'));
    if (m) out[tok] = m[1].toLowerCase();
  }
  return out;
}

// The base block is the one whose selector list pairs :root with the
// dark theme — it carries the defaults every theme overlays.
const baseMatch = /:root\s*,\s*\[data-theme="dark"\]\s*\{/.exec(stripped);
if (!baseMatch) {
  console.error('check-theme-contrast: base theme block (:root, [data-theme="dark"]) not found in styles.css');
  process.exit(1);
}
const base = parseTokens(blockBodyAfter(stripped, baseMatch.index));

const themes = new Map();
themes.set('dark', { ...base });
const themeRe = /\[data-theme="([a-z0-9-]+)"\]\s*\{/g;
let m;
while ((m = themeRe.exec(stripped)) !== null) {
  const name = m[1];
  if (name === 'dark') continue; // already seeded from the base block
  const own = parseTokens(blockBodyAfter(stripped, m.index));
  themes.set(name, { ...base, ...own });
}

function luminance(hex) {
  const chan = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
}

function ratio(a, b) {
  const [hi, lo] = luminance(a) >= luminance(b) ? [a, b] : [b, a];
  return (luminance(hi) + 0.05) / (luminance(lo) + 0.05);
}

const failures = [];
let pairs = 0;
for (const [name, t] of themes) {
  const missing = TOKENS.filter(tok => !t[tok]);
  if (missing.length) {
    failures.push(`${name}: missing token(s) ${missing.join(', ')} after overlay`);
    continue;
  }
  for (const text of TEXT_TOKENS) {
    for (const surf of SURFACES) {
      pairs++;
      const r = ratio(t[text], t[surf]);
      if (r < FLOOR) {
        failures.push(`${name}: ${text} ${t[text]} on ${surf} ${t[surf]} = ${r.toFixed(2)}:1 (< ${FLOOR}:1)`);
      }
    }
  }
}

if (failures.length) {
  console.error(`check-theme-contrast: ${failures.length} failing pair(s) across ${themes.size} themes (${pairs} pairs checked):`);
  failures.forEach(f => console.error('  ' + f));
  process.exit(1);
}
console.log(`check-theme-contrast: ${themes.size}/${themes.size} themes pass — all ${pairs} text/surface pairs >= ${FLOOR}:1`);
