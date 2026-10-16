// Tests for v129 — accessibility pass (UI Improvement Pass, section 15).
//
// Covered: book modal is a labelled dialog (role/aria-modal/aria-label);
// the close button has an accessible name; Escape closes the book modal;
// Escape skips the onboarding tour; the onboarding overlay is a labelled
// dialog; global :focus-visible styling and a global reduced-motion rule
// exist in the stylesheet.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);
const q = (sel) => window.document.querySelector(sel);
const escKey = () => window.document.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

// --- book modal ---
run(`library = [
  { id: 'b1', title: 'Test Book', authors: ['A'], status: 'tbr', progress: 0,
    pageCount: 200, cover: '', tropes: [], genres: [], myRating: 0,
    ratings: {}, axes: [], favorite: false, notes: '' }
];
openDetail('b1');`);
const dlg = q('#m-back .modal');
ok('modal: role=dialog', dlg && dlg.getAttribute('role') === 'dialog');
ok('modal: aria-modal + accessible label',
  dlg.getAttribute('aria-modal') === 'true' && !!dlg.getAttribute('aria-label'));
ok('modal: close button named', q('#m-x').getAttribute('aria-label') === 'Close');

escKey();
ok('modal: Escape closes it', !q('#m-back .modal'));

// --- onboarding ---
run(`try { localStorage.removeItem('spicyshelves.onboarded'); } catch (e) {}
library = []; maybeOnboard();`);
const ov = q('#onb-overlay');
ok('onboarding: role=dialog', ov.getAttribute('role') === 'dialog');
ok('onboarding: aria-modal + label',
  ov.getAttribute('aria-modal') === 'true' && !!ov.getAttribute('aria-label'));
escKey();
ok('onboarding: Escape skips the tour',
  !q('#onb-overlay') && run(`onboarded()`) === true);

// --- stylesheet ---
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
ok('css: :focus-visible rule', /:focus-visible\s*\{[^}]*outline/.test(css));
ok('css: global reduced-motion kill-switch',
  /prefers-reduced-motion:\s*reduce[\s\S]*?\*\s*,\s*\*::before/.test(css));

// --- v590 accessibility pack, hybrid placement ---
// aria-pressed on every seg button + hide-shelf chip in the cluster (state
// must be programmatically determinable, not colour/bold alone); aria-live
// on the toast root; label association for the account form + login fields;
// seg touch targets ≥44px; the two measured default-theme contrast failures
// (hint --faint on card 4.29:1, white on --accent 4.23:1) fixed at token level.
// The hybrid moves the form + gift cluster mounts from Settings to the
// Profile view — the pack's assertions scan BOTH mounts so the move can
// never silently drop coverage.
(async () => {
  const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });
  const qa = (s, root) => Array.from((root || window.document).querySelectorAll(s));

  ok('toast root carries aria-live="polite" in index.html',
    /<div id="toast-root"[^>]*aria-live="polite"/.test(html));
  run(`toast('a11y probe')`);
  ok('toast root has aria-live at runtime', q('#toast-root').getAttribute('aria-live') === 'polite');

  // Every seg button / shelf chip in a markup chunk carries aria-pressed
  // that agrees with its .active state.
  const pressedOk = (label, markup) => {
    const host = window.document.createElement('div');
    host.innerHTML = markup;
    const btns = qa('.seg button, .chip[data-shelf]', host);
    ok(label + ': controls exist to scan', btns.length > 0);
    ok(label + ': every seg button / shelf chip carries aria-pressed in step with .active',
      btns.every(b => b.getAttribute('aria-pressed') === String(b.classList.contains('active'))));
  };
  const priv = { share: true, hidden: ['tbr'], bio: true, activity: false, recos: true, buddy: true, marginalia: true, giftClaims: false };
  pressedOk('privacy panel', run(`circlePrivacyPanelHTML(${JSON.stringify(priv)}, 'st', ['tbr', 'read'])`));
  pressedOk('content shield seg', run(`shieldSegHTML('rd', true)`));
  pressedOk('gift cluster', run(`giftClusterHTML('pf', false)`));
  pressedOk('gift sharing seg', run(`giftSegHTML('gift-sharing', true)`));

  // The rendered Settings surface: every seg button in the view is pressed-aware.
  run(`localStorage.clear(); library = []; view = 'settings'; renderSettings();`);
  await tick(3);
  const viewSegBtns = qa('#view .seg button');
  ok('settings view: seg buttons exist to scan', viewSegBtns.length > 0);
  ok('settings view: every seg button carries aria-pressed in step with .active',
    viewSegBtns.every(b => b.getAttribute('aria-pressed') === String(b.classList.contains('active'))));

  // Label association: every field control in the Account group is labelled
  // (label[for], aria-label, or aria-labelledby) — login fields included.
  const unlabelled = qa('#view input, #view textarea, #view select').filter(el => {
    if (el.type === 'hidden' || el.type === 'file' || el.type === 'checkbox') return false;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
    return !(el.id && window.document.querySelector('label[for="' + el.id + '"]'));
  });
  ok('account/settings fields: every text control has an associated label',
    unlabelled.length === 0);
  ok('login fields have real labels (not placeholder-only)',
    !!window.document.querySelector('label[for="ac-email"]') &&
    !!window.document.querySelector('label[for="ac-pass"]'));

  // The Profile view mount (hybrid): the identity form + gift cluster
  // live here now — scan its seg buttons and its field labels too.
  run(`cloudUser = { id: 'a11y-u', email: 'a11y@example.com' }; view = 'profile'; renderProfile();`);
  await tick(3);
  const pfSegBtns = qa('#view .seg button');
  ok('profile view: seg buttons exist to scan', pfSegBtns.length > 0);
  ok('profile view: every seg button carries aria-pressed in step with .active',
    pfSegBtns.every(b => b.getAttribute('aria-pressed') === String(b.classList.contains('active'))));
  const pfUnlabelled = qa('#view input, #view textarea, #view select').filter(el => {
    if (el.type === 'hidden' || el.type === 'file' || el.type === 'checkbox') return false;
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
    return !(el.id && window.document.querySelector('label[for="' + el.id + '"]'));
  });
  ok('profile view fields: every text control has an associated label',
    pfUnlabelled.length === 0);

  // Warning preferences: filter input narrows both pill lists; chips are pressed-aware.
  // The taxonomy read is the community corpus client's; stub it.
  run(`window.CommunityCorpus = window.CommunityCorpus || {};
    window.CommunityCorpus.taxonomy = async () => ([
      { id: 'abuse', label: 'Abuse' }, { id: 'violence', label: 'Violence' }, { id: 'grief', label: 'Grief' }
    ]);`);
  run(`openWarningPrefs();`);
  await tick(6);
  const wpSheet = q('#warnPrefSheet');
  ok('warning prefs: sheet opens', !!wpSheet);
  const wpFilter = q('#wpFilter');
  ok('warning prefs: a text filter exists', !!wpFilter);
  const chips = qa('.survey-chip', wpSheet);
  ok('warning prefs: category chips render', chips.length > 0);
  ok('warning prefs: chips carry aria-pressed in step with selection',
    chips.every(c => c.getAttribute('aria-pressed') === String(c.classList.contains('on'))));
  if (wpFilter && chips.length) {
    wpFilter.value = 'abuse';
    wpFilter.dispatchEvent(new window.Event('input', { bubbles: true }));
    const visible = chips.filter(c => c.style.display !== 'none');
    ok('warning prefs: filter narrows both lists to matching categories',
      visible.length > 0 && visible.length < chips.length &&
      visible.every(c => /abuse/i.test(c.textContent)));
    wpFilter.value = '';
    wpFilter.dispatchEvent(new window.Event('input', { bubbles: true }));
    ok('warning prefs: clearing the filter restores every chip',
      chips.every(c => c.style.display !== 'none'));
    const chip = chips[0];
    chip.click(); await tick();
    ok('warning prefs: toggling a chip syncs aria-pressed',
      chip.getAttribute('aria-pressed') === String(chip.classList.contains('on')));
  }
  run(`document.getElementById('wpCancel') && document.getElementById('wpCancel').click();`);
  await tick(3);

  // Stylesheet: seg target size + token-level contrast on the default theme.
  ok('css: seg buttons are at least 44px tall',
    /\.seg button\s*\{[^}]*min-height:\s*44px/.test(css));
  ok('css: active seg uses the deeper accent token',
    /\.seg button\.active\s*\{[^}]*var\(--accent-deep\)/.test(css));
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const c = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const rootBlock = (css.match(/:root, \[data-theme="dark"\]\s*\{[^}]*\}/) || [''])[0];
  const tok = (name) => { const m = rootBlock.match(new RegExp(name + ':\\s*(#[0-9a-fA-F]{6})')); return m && m[1]; };
  ok('css: default-theme --faint passes AA on card surfaces (was 4.29:1)',
    ratio(tok('--faint'), tok('--card')) >= 4.5 && ratio(tok('--faint'), tok('--card2')) >= 4.5);
  ok('css: white on default --accent-deep passes AA for active seg text (was 4.23:1 on --accent)',
    ratio('#ffffff', tok('--accent-deep')) >= 4.5);

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
