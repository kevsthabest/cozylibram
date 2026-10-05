const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
require('/home/hatch/workspace/booktok/.test/harness').loadApp(window);
const run = (js) => window.eval(js);
const tests = [];
// kv2 (wood floor)
tests.push(['/tmp/kv2.json', 'kv2']);
// frame3 / frame19 re-extracted
[['/tmp/f3b.png', 3, '/tmp/frame3.json', {x:90,y:89,w:60,h:249}],
 ['/tmp/f19b.png', 19, '/tmp/frame19.json', {x:90,y:89,w:60,h:249}]].forEach(function (t) {
  run(`(function () {
    var img = null;
    return 'skip';
  })()`);
  tests.push([t[2], t[0] === 3 ? 'frame3' : 'frame19', t[1], t[3]]);
});
console.log(run(`
(function () {
  function sobelX(g, w, h) {
    var gx = new Uint16Array(w*h);
    for (var y = 1; y < h-1; y++) for (var x = 1; x < w-1; x++) {
      var i = y*w+x;
      gx[i] = Math.abs(-g[i-w-1]-2*g[i-1]-g[i+w-1]+g[i-w+1]+2*g[i+1]+g[i+w+1]);
    }
    return gx;
  }
  function colRuns(gray, w, h, roi, thresh) {
    var gx = sobelX(ecBlur3(gray, w, h), w, h);
    var x0 = Math.max(1, Math.floor(roi.x)), x1 = Math.min(w-2, Math.ceil(roi.x+roi.w));
    var y0 = Math.max(1, Math.floor(roi.y)), y1 = Math.min(h-2, Math.ceil(roi.y+roi.h));
    var out = [];
    for (var x = x0; x <= x1; x++) {
      var best = 0, cur = 0;
      for (var y = y0; y <= y1; y++) {
        if (gx[y*w+x] > thresh) { cur++; if (cur > best) best = cur; } else cur = 0;
      }
      out.push((x) + ':' + best);
    }
    return 'x0=' + x0 + ' ' + out.filter(function (_, i) { return i % 2 === 0; }).join(' ');
  }
  var res = [];
  res.push('KV2: ' + colRuns(new Uint8ClampedArray(window.__pxA), window.__wA, window.__hA, window.__roiA, 100));
  return res.join('\\n');
})()`));
process.exit(0);
