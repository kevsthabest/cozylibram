/* ---------------- AppLog: on-device diagnostic log (v167) ----------------
   A tiny ring buffer for troubleshooting: JS errors, sync push/pull
   outcomes, cover changes, and anything else worth tracing. Entries live
   in memory (last 300) and the newest 150 persist in localStorage so they
   survive a reload. Nothing here ever leaves the device — the viewer is
   admin-only in the Libram Observatory. Every method is throw-safe: a
   logging failure must never break the app it instruments. */

const APP_LOG_MEM_MAX = 300;
const APP_LOG_STORE_MAX = 150;
const APP_LOG_KEY = 'cozylibram.applog.v1';

const AppLog = {
  _mem: [],
  _levels: { info: 0, warn: 1, error: 2 },

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
      localStorage.removeItem(APP_LOG_KEY);
    } catch (e) {}
  },
};

AppLog._restore();

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
