'use strict';

/* ---------------- app version + updates ----------------
   The phone caches the app aggressively (service worker), so after a new
   zip is deployed the device can look "stuck" on the old version. This
   shows the version actually running on THIS device and offers a manual
   update check. */

/* The version stamped onto every analytics event (v118+). Paired with the
   service-worker cache name by appversion.test.js — bump BOTH on release. */



const APP_VERSION = 'v441';


/* Pure: pull 'vNN' out of sw.js text. Covered by appversion.test.js. */
function parseSwVersion(text) {
  const m = /cozy-libram-(v\d+)/.exec(text || '');
  return m ? m[1] : null;
}

/* This fetch goes through the controlling service worker (cache-first), so
   the sw.js we read back is the one that installed the running version —
   i.e. the version this device is actually on, not the server's. */
async function runningAppVersion() {
  try {
    const res = await fetch('./sw.js');
    if (!res.ok) return null;
    return parseSwVersion(await res.text());
  } catch (e) { return null; }
}

/* v55 marker: present only in the fixed grid CSS. Checked by cssGridStatus(). */
function cssHasTileFix(cssText) {
  return /v5[57]-tile/.test(cssText || '');
}

/* Cached CSS: fetched through the controlling service worker (cache-first),
   so this is the stylesheet the running page actually applied. */
async function cachedCssStatus() {
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
async function serverCssStatus() {
  try {
    const res = await fetch('./styles.css?probe=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return 'unreadable';
    return cssHasTileFix(await res.text()) ? 'new' : 'old';
  } catch (e) { return 'unreadable'; }
}

/* Ask the service worker for an update; reload into it when one is ready. */
async function checkForAppUpdate(statusEl) {
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
function _showUpdateBanner() {
  if (document.getElementById('app-update-banner')) return;
  const b = document.createElement('div');
  b.id = 'app-update-banner';
  b.innerHTML = '<span>✨ A new version is available.</span>' +
    '<button id="app-update-go">Refresh</button>' +
    '<button id="app-update-x" aria-label="Dismiss">×</button>';
  b.querySelector('#app-update-go').addEventListener('click', () => location.reload());
  b.querySelector('#app-update-x').addEventListener('click', () => b.remove());
  document.body.appendChild(b);
}
async function watchForAppUpdates() {
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
