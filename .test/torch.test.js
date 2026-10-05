// Torch toggle (v290): ecTorchWire wires the button only when the camera
// reports a torch capability, and cleanup extinguishes it.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);
const tick = () => new Promise(r => setTimeout(r, 50));

(async () => {
  // Camera with torch support.
  run(`window.__applied = [];
var fakeTrack = {
  getCapabilities: function () { return { torch: true }; },
  applyConstraints: function (c) { window.__applied.push(c); return Promise.resolve(); }
};
var v = document.createElement('video');
Object.defineProperty(v, 'srcObject', { value: { getVideoTracks: function () { return [fakeTrack]; } }, configurable: true });
var b = document.createElement('button'); b.hidden = true; b.id = 't1';
document.body.appendChild(b);
window.__cleanup = ecTorchWire(v, b);`);
  ok('torch button unhidden when supported', run(`document.getElementById('t1').hidden`) === false);
  ok('label starts off', run(`document.getElementById('t1').textContent`) === 'Flash: off');
  ok('returns a cleanup function', run(`typeof window.__cleanup`) === 'function');

  run(`document.getElementById('t1').click();`);
  await tick();
  ok('click turns torch on via constraint',
    JSON.stringify(run(`window.__applied[0]`)) === JSON.stringify({ advanced: [{ torch: true }] }));
  ok('label flips on', run(`document.getElementById('t1').textContent`) === 'Flash: on');

  run(`document.getElementById('t1').click();`);
  await tick();
  ok('second click turns torch off',
    JSON.stringify(run(`window.__applied[1]`)) === JSON.stringify({ advanced: [{ torch: false }] }));

  run(`window.__cleanup();`);
  await tick();
  ok('cleanup extinguishes the torch',
    JSON.stringify(run(`window.__applied[2]`)) === JSON.stringify({ advanced: [{ torch: false }] }));

  // Camera without torch support: button stays hidden, returns null.
  run(`var v2 = document.createElement('video');
Object.defineProperty(v2, 'srcObject', { value: { getVideoTracks: function () {
  return [{ getCapabilities: function () { return {}; } }]; } }, configurable: true });
var b2 = document.createElement('button'); b2.hidden = true; b2.id = 't2';
document.body.appendChild(b2);
window.__cleanup2 = ecTorchWire(v2, b2);`);
  ok('unsupported camera keeps button hidden', run(`document.getElementById('t2').hidden`) === true);
  ok('unsupported returns null', run(`window.__cleanup2`) === null);

  // No stream at all.
  run(`var b3 = document.createElement('button'); b3.hidden = true; b3.id = 't3';
document.body.appendChild(b3);
window.__cleanup3 = ecTorchWire(document.createElement('video'), b3);`);
  ok('no stream keeps button hidden and returns null',
    run(`document.getElementById('t3').hidden`) === true && run(`window.__cleanup3`) === null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
