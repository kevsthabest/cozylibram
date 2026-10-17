/* js/002-log.js — AppLog: the on-device diagnostic log (v167).
 *
 * A tiny ring buffer for troubleshooting: JS errors, sync push/pull
 * outcomes, cover changes, and anything else worth tracing. Entries
 * live in memory (the last APP_LOG_MEM_MAX = 300) and the newest
 * APP_LOG_STORE_MAX = 150 persist in localStorage under APP_LOG_KEY
 * so they survive a reload. Nothing here ever leaves the device —
 * the log is read on-device in the Observatory's Logs tab
 * (js/166-logs.js, dispatched by js/199-admin.js). This file also
 * installs the global safety net: uncaught errors and unhandled
 * promise rejections are captured here so silent failures become
 * visible in that viewer.
 *
 * Every method is throw-safe: a logging failure must never break the
 * app it instruments. Persistence is throttled (see
 * APP_LOG_PERSIST_MS below) with a flush on pagehide, so the last
 * entries before unload still survive.
 *
 * AppLog is the tree's most widely read surface: most files read it
 * as a global through the window bridge at the bottom of this file,
 * while js/166-logs.js and js/181-appversion.js import it directly.
 * Behaviour is pinned by .test/applog.test.js. This file reads
 * nothing from any other module.
 */

export const APP_LOG_MEM_MAX = 300;
export const APP_LOG_STORE_MAX = 150;
export const APP_LOG_KEY = 'cozylibram.applog.v1';
// Persisting on every log call meant a device-storage write per save
// (scheduleCloudPush logs on every save) plus every sync event, so
// writes are throttled to one per APP_LOG_PERSIST_MS, with a flush on
// pagehide so the last entries before unload still survive a reload
// (v494, #133).

export const APP_LOG_PERSIST_MS = 2000;

export const AppLog = {
  _mem: [],
  _levels: { info: 0, warn: 1, error: 2 },
  _lastPersist: 0,
  _persistPending: false,

  _write(level, tag, msg) {
    try {
      if (!this._levels.hasOwnProperty(level)) level = 'info';
      msg = String(msg == null ? '' : msg).slice(0, 500);
      tag = String(tag == null ? '' : tag).slice(0, 40);
      this._mem.push({ t: Date.now(), level, tag, msg });
      if (this._mem.length > APP_LOG_MEM_MAX) {
        this._mem.splice(0, this._mem.length - APP_LOG_MEM_MAX);
      }
      this._persist();
    } catch (e) { /* logging must never throw */ }
  },

  _persist() {
    try {
      if (Date.now() - this._lastPersist < APP_LOG_PERSIST_MS) { this._persistPending = true; return; }
      this._flush();
    } catch (e) { /* logging must never throw */ }
  },

  // Unconditional write-through: pagehide flush and clear().
  _flush() {
    try {
      this._lastPersist = Date.now();
      this._persistPending = false;
      const keep = this._mem.slice(-APP_LOG_STORE_MAX);
      localStorage.setItem(APP_LOG_KEY, JSON.stringify(keep));
    } catch (e) { /* storage full/blocked: keep the in-memory copy */ }
  },

  _restore() {
    try {
      const raw = localStorage.getItem(APP_LOG_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        this._mem = arr.filter(e => e && typeof e.t === 'number').slice(-APP_LOG_MEM_MAX);
      }
    } catch (e) { this._mem = []; }
  },

  info(tag, msg) { this._write('info', tag, msg); },
  warn(tag, msg) { this._write('warn', tag, msg); },
  error(tag, msg) { this._write('error', tag, msg); },

  /* Newest-first. `level` filters to that level and above
     ('error' -> errors only, 'warn' -> warn+error, 'info' -> all). */
  entries(level) {
    try {
      const rank = this._levels[level] || 0;
      return this._mem
        .filter(e => (this._levels[e.level] || 0) >= rank)
        .slice().reverse();
    } catch (e) { return []; }
  },

  clear() {
    try {
      this._mem = [];
      // Reset the throttle so the next write persists immediately —
      // a clear followed by writes (and the tests) expect them stored.
      this._lastPersist = 0;
      this._persistPending = false;
      localStorage.removeItem(APP_LOG_KEY);
    } catch (e) {}
  },
};

AppLog._restore();

try {
  window.addEventListener('pagehide', () => { try { AppLog._flush(); } catch (e) {} });
} catch (e) { /* very old webviews: skip the flush hook */ }

/* Global safety net: uncaught exceptions and unhandled promise rejections
   land here so silent failures become visible in the log viewer. */
try {
  window.addEventListener('error', e => {
    try {
      const where = (e.filename || '').split('/').pop();
      AppLog.error('js', 'uncaught: ' + (e.message || 'script error') +
        (where ? ' @ ' + where + ':' + (e.lineno || '?') : ''));
    } catch (x) {}
  });
  window.addEventListener('unhandledrejection', e => {
    try {
      const r = e && e.reason;
      const msg = r && r.message ? r.message : String(r);
      AppLog.error('js', 'unhandled rejection: ' + String(msg).slice(0, 300));
    } catch (x) {}
  });
} catch (e) { /* very old webviews: skip the safety net */ }

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Nineteen files across the tree (js/040-storage,
   js/090-sync and seventeen more) still read AppLog as a global at
   runtime, so the bridge republishes exactly the pre-conversion
   public surface on window. Bare-name lookups resolve through the
   global object, so the callers need no changes. Module scripts are
   deferred, so the bridge is in place before any consumer can run.
   Remove a name from this bridge only when its last window-reading
   caller has wired the read as an import (ADR-003). */
window.APP_LOG_MEM_MAX = APP_LOG_MEM_MAX;
window.APP_LOG_STORE_MAX = APP_LOG_STORE_MAX;
window.APP_LOG_KEY = APP_LOG_KEY;
window.APP_LOG_PERSIST_MS = APP_LOG_PERSIST_MS;
window.AppLog = AppLog;
