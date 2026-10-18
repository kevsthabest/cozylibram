'use strict';

/* js/181-appversion.js — App version: which version is running on
 * this device, and is a newer one available?
 *
 * APP_VERSION is the release stamp, paired with the service worker's
 * CACHE name in sw.js — bump both on release (the pairing is asserted
 * in .test/book-ambience.test.js; this file's parsers are covered by
 * .test/appversion.test.js). The version is also stamped onto every
 * analytics event: js/065 reads APP_VERSION through the bridge.
 *
 * The rest of the file exists because the phone caches the app
 * aggressively (service worker), so after a deploy a device can look
 * stuck on the old version — and "which version am I on?" has three
 * different honest answers. APP_VERSION is the running bundle;
 * runningAppVersion reads sw.js back through the controlling service
 * worker (cache-first), i.e. the copy this device actually runs;
 * checkBootVersion instead fetches this file from the server (the
 * ?probe= query busts the cache-first match) and, on a mismatch,
 * raises the tap-to-refresh banner — never an auto-reload, because
 * the reader might be mid-action. watchForAppUpdates drives the same
 * banner from service-worker lifecycle events instead. Everything
 * here is best-effort: a failed probe (offline) skips silently.
 *
 * This file's outbound reads are wired as real imports — AppLog from
 * js/002-log.js, icon from js/050-helpers.js (see ADR-003); its own
 * surface still reaches js/065, js/095 and js/180 through the window
 * bridge at the bottom of this file.
 */
import { AppLog } from './002-log.js';
import { icon } from './050-helpers.js';

export const APP_VERSION = 'v617';


/* Pure: pull 'vNN' out of sw.js text. Covered by appversion.test.js. */
export function parseSwVersion(text) {
  const m = /cozy-libram-(v\d+)/.exec(text || '');
  return m ? m[1] : null;
}

/* This fetch goes through the controlling service worker (cache-first), so
   the sw.js we read back is the one that installed the running version —
   i.e. the version this device is actually on, not the server's. */
export async function runningAppVersion() {
  try {
    const res = await fetch('./sw.js');
    if (!res.ok) return null;
    return parseSwVersion(await res.text());
  } catch (e) { return null; }
}

/* v55 marker: present only in the fixed grid CSS. Checked by cssGridStatus(). */
export function cssHasTileFix(cssText) {
  return /v5[57]-tile/.test(cssText || '');
}

/* Cached CSS: fetched through the controlling service worker (cache-first),
   so this is the stylesheet the running page actually applied. */
export async function cachedCssStatus() {
  try {
    const res = await fetch('./styles.css');
    if (!res.ok) return 'unreadable';
    return cssHasTileFix(await res.text()) ? 'new' : 'old';
  } catch (e) { return 'unreadable'; }
}

/* Server CSS: the ?probe= query busts the service-worker cache (the precache
   key has no query string), so the request falls through to the network and
   reveals the stylesheet file currently on the server. If the server copy is
   old while the app is new, the zip was not extracted cleanly on the PC. */
export async function serverCssStatus() {
  try {
    const res = await fetch('./styles.css?probe=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return 'unreadable';
    return cssHasTileFix(await res.text()) ? 'new' : 'old';
  } catch (e) { return 'unreadable'; }
}

/* Pure: pull 'vNNN' out of js/181-appversion.js text. Covered by appversion.test.js. */
export function parseAppVersion(text) {
  const m = /APP_VERSION\s*=\s*'(v\d+)'/.exec(text || '');
  return m ? m[1] : null;
}

/* v491: stale-bundle detector. The fetch goes to the server copy, not the
   SW precache — the ?probe= query busts the cache-first match (same trick as
   serverCssStatus), so a mismatch means the running bundle really is old.
   Shows the existing tap-to-refresh banner; never auto-reloads (the user
   might be mid-action). Runs once per app entry; a failed probe (offline)
   skips silently. */
export let bootVersionChecked = false;
export async function checkBootVersion() {
  if (bootVersionChecked) return;
  bootVersionChecked = true;
  try {
    const res = await fetch('./js/181-appversion.js?probe=' + Date.now(), { cache: 'no-store' });
    if (!res || !res.ok) return;
    const serverVersion = parseAppVersion(await res.text());
    if (serverVersion && typeof APP_VERSION === 'string' && serverVersion !== APP_VERSION) {
      if (typeof _showUpdateBanner === 'function') _showUpdateBanner();
      try { if (typeof AppLog === 'object' && AppLog) AppLog.log('app', 'stale bundle: running ' + APP_VERSION + ', server has ' + serverVersion); } catch (_) {}
    }
  } catch (e) { /* offline or probe blocked — skip silently */ }
}

/* Ask the service worker for an update; reload into it when one is ready. */
export async function checkForAppUpdate(statusEl) {
  const say = t => { if (statusEl) statusEl.textContent = t; };
  try {
    if (!('serviceWorker' in navigator)) { say('No service worker in this browser.'); return; }
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { say('Not installed here — just reload the page.'); return; }
    say('Checking for updates…');
    await reg.update();
    if (reg.waiting) {
      say('Update ready — reloading…');
      setTimeout(() => location.reload(), 600);
      return;
    }
    let nw = reg.installing;
    if (!nw) {
      nw = await new Promise(resolve => {
        const to = setTimeout(() => resolve(null), 4000);
        reg.addEventListener('updatefound', () => { clearTimeout(to); resolve(reg.installing); }, { once: true });
      });
    }
    if (!nw) { say('You are on the latest version ✓'); return; }
    await new Promise(resolve => {
      if (nw.state === 'installed' || nw.state === 'redundant') return resolve();
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' || nw.state === 'redundant') resolve();
      });
    });
    if (reg.waiting) {
      say('Update ready — reloading…');
      setTimeout(() => location.reload(), 600);
    } else {
      say('You are on the latest version ✓');
    }
  } catch (e) { say('Could not check: ' + (e && e.message ? e.message : e)); }
}

/* v432: automatic "update available" prompt. When the SW finds a new version
   in the background, show a tap-to-refresh banner instead of silently serving
   stale bundles. Kills the stale-bundle class of bug reports. */
export function _showUpdateBanner() {
  if (document.getElementById('app-update-banner')) return;
  const b = document.createElement('div');
  b.id = 'app-update-banner';
  b.innerHTML = '<span>' + icon('sparkles') + ' A new version is available.</span>' +
    '<button id="app-update-go">Refresh</button>' +
    '<button id="app-update-x" aria-label="Dismiss">×</button>';
  b.querySelector('#app-update-go').addEventListener('click', () => location.reload());
  b.querySelector('#app-update-x').addEventListener('click', () => b.remove());
  document.body.appendChild(b);
}
export async function watchForAppUpdates() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    // Already waiting? Show immediately.
    if (reg.waiting) { _showUpdateBanner(); return; }
    // Watch for a new SW installing in the background.
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && reg.waiting) _showUpdateBanner();
      });
    });
    // Periodic check (every 30 min) — the browser also checks on navigation.
    setInterval(() => { reg.update().catch(() => {}); }, 30 * 60 * 1000);
  } catch (e) {}
}
// Start watching once the app boots.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchForAppUpdates, { once: true });
} else {
  watchForAppUpdates();
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its consumers — js/065-analytics.js,
   js/095-gate.js and js/180-settings.js — still read this surface as
   globals at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups resolve
   through the global object, so the callers need no changes. Module
   scripts are deferred, so the bridge is in place before any consumer
   can run. Remove a name from this bridge only when its last
   window-reading caller has wired the read as an import (ADR-003). */
window.APP_VERSION = APP_VERSION;
window.parseSwVersion = parseSwVersion;
window.runningAppVersion = runningAppVersion;
window.cssHasTileFix = cssHasTileFix;
window.cachedCssStatus = cachedCssStatus;
window.serverCssStatus = serverCssStatus;
window.parseAppVersion = parseAppVersion;
window.bootVersionChecked = bootVersionChecked;
window.checkBootVersion = checkBootVersion;
window.checkForAppUpdate = checkForAppUpdate;
window._showUpdateBanner = _showUpdateBanner;
window.watchForAppUpdates = watchForAppUpdates;
