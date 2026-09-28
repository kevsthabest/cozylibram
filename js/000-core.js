'use strict';

/* Cozy Libram v1 — mobile-first personal library PWA.
   Storage: localStorage (on-device). Metadata: Google Books API + Open Library covers.
   No backend, no account, works from any static host. */

'use strict';

const LS_KEY = 'spicyshelves.library.v1';
const STATUS = {
  tbr: 'To Be Read',
  reading: 'Currently Reading',
  read: 'Read',
  dnf: 'Did Not Finish'
};

let view = 'library';
let filter = 'all';
let ownFilter = 'all'; // all | owned | tobuy | borrowed (v148)
let query = '';
let heatSel = null; // selected heatmap day 'YYYY-MM-DD' (v62)
let calY = new Date().getFullYear(); // v63: month calendar restored
let calM = new Date().getMonth();
let calSel = null; // selected calendar day 'YYYY-MM-DD'
let genreGran = 'quarter'; // v69: genre evolution granularity (year|quarter|month)
let layout = 'grid'; // v57: grid view restored (Bookmory-style); default grid
try { layout = localStorage.getItem('spicyshelves.layout') || 'grid'; } catch (e) {}
let animateIn = true; // staggered card entrance; disabled while typing in search
let rouletteTimer = null; // slot-machine animation handle
let pickState = { genres: [], trope: '', minIntensity: 0, upNextOnly: false };
let addTab = 'scan';
let editingId = null;
let editingDraft = null; // live draft of the open book modal (for background fills)
let refreshProgressSection = null; // re-render fn for the open modal's progress section
let searchResults = [];
let searchQuery = ''; // v150: last Add → Search query, restored across re-renders
let searchSource = 'all'; // v139: Add → Search source filter (all/gbooks/openlibrary/hardcover)
let scanState = { stream: null, timer: null, active: false, quagga: false };

