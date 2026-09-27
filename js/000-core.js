'use strict';

/* Spicy Shelves v1 — mobile-first personal library PWA.
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
let ownFilter = 'all'; // all | owned | tobuy
let query = '';
let calY = new Date().getFullYear();
let calM = new Date().getMonth();
let calSel = null; // selected calendar day 'YYYY-MM-DD'
let layout = 'list'; // v56: grid view temporarily removed — always list for now
let animateIn = true; // staggered card entrance; disabled while typing in search
let rouletteTimer = null; // slot-machine animation handle
let pickState = { genres: [], trope: '', minIntensity: 0 };
let addTab = 'scan';
let editingId = null;
let editingDraft = null; // live draft of the open book modal (for background fills)
let refreshProgressSection = null; // re-render fn for the open modal's progress section
let searchResults = [];
let scanState = { stream: null, timer: null, active: false, quagga: false };

