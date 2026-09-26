// Shared test harness: loads the app's js/*.js modules (in numeric load order,
// same as index.html) into a JSDOM window as classic scripts.
const fs = require('fs');
const path = require('path');

const APP_DIR = '/home/hatch/workspace/booktok';

function jsFiles() {
  return fs.readdirSync(path.join(APP_DIR, 'js'))
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(APP_DIR, 'js', f));
}

function loadApp(window) {
  for (const file of jsFiles()) {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(file, 'utf8');
    window.document.body.appendChild(el);
  }
}

module.exports = { loadApp, jsFiles, APP_DIR };
